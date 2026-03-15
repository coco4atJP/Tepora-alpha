use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::core::errors::ApiError;
use crate::llm::external_loader_common::{extract_usage, post_json};
use crate::llm::types::{ChatRequest, NormalizedAssistantTurn, NormalizedStreamChunk};

pub(crate) async fn chat(
    http: &Client,
    base_url: &str,
    model_name: &str,
    request: ChatRequest,
    request_timeout: Duration,
) -> Result<NormalizedAssistantTurn, ApiError> {
    let endpoint = format!("{}/api/v1/chat", base_url.trim_end_matches('/'));
    let body = build_lmstudio_chat_body(model_name, request, false);
    let response = post_json(
        http,
        &endpoint,
        &body,
        "lmstudio",
        base_url,
        request_timeout,
    )
    .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "lmstudio native chat request failed ({}): {}",
            status, text
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let mut reasoning_text = String::new();
    let mut message_text = String::new();

    if let Some(outputs) = payload.get("output").and_then(|v| v.as_array()) {
        for item in outputs {
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let content = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
            match item_type {
                "reasoning" => reasoning_text.push_str(content),
                "message" => message_text.push_str(content),
                _ => {}
            }
        }
    }

    Ok(NormalizedAssistantTurn {
        visible_text: message_text,
        model_thinking: reasoning_text,
        finish_reason: None,
        usage: extract_usage(&payload),
    })
}

pub(crate) async fn stream_chat(
    http: &Client,
    base_url: &str,
    model_name: &str,
    request: ChatRequest,
    request_timeout: Duration,
    stream_idle_timeout: Duration,
) -> Result<mpsc::Receiver<Result<NormalizedStreamChunk, ApiError>>, ApiError> {
    let endpoint = format!("{}/api/v1/chat", base_url.trim_end_matches('/'));
    let body = build_lmstudio_chat_body(model_name, request, true);
    let response = post_json(
        http,
        &endpoint,
        &body,
        "lmstudio",
        base_url,
        request_timeout,
    )
    .await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "lmstudio native streaming request failed ({}): {}",
            status, text
        )));
    }

    let (tx, rx) = mpsc::channel(128);
    let mut byte_stream = response.bytes_stream();
    tokio::spawn(async move {
        let mut buffer = String::new();
        loop {
            let next = tokio::time::timeout(stream_idle_timeout, byte_stream.next()).await;
            let next = match next {
                Ok(value) => value,
                Err(_) => {
                    let _ = tx
                        .send(Err(ApiError::Internal(format!(
                            "lmstudio stream idle timeout after {} ms",
                            stream_idle_timeout.as_millis()
                        ))))
                        .await;
                    return;
                }
            };

            let Some(next) = next else {
                break;
            };

            match next {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(double_newline) = buffer.find("\n\n") {
                        let event_block = buffer[..double_newline].to_string();
                        buffer = buffer[(double_newline + 2)..].to_string();

                        let mut event_type = String::new();
                        let mut event_data = String::new();
                        for line in event_block.lines() {
                            if let Some(t) = line.strip_prefix("event: ") {
                                event_type = t.trim().to_string();
                            } else if let Some(d) = line.strip_prefix("data: ") {
                                event_data = d.trim().to_string();
                            }
                        }

                        match event_type.as_str() {
                            "reasoning.start" | "reasoning.end" => {}
                            "reasoning.delta" => {
                                if let Ok(parsed) = serde_json::from_str::<Value>(&event_data) {
                                    let content = parsed
                                        .get("content")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    if !content.is_empty()
                                        && tx
                                            .send(Ok(NormalizedStreamChunk {
                                                visible_text: String::new(),
                                                model_thinking: content.to_string(),
                                                done: false,
                                                usage: extract_usage(&parsed),
                                            }))
                                            .await
                                            .is_err()
                                    {
                                        return;
                                    }
                                }
                            }
                            "message.delta" => {
                                if let Ok(parsed) = serde_json::from_str::<Value>(&event_data) {
                                    let content = parsed
                                        .get("content")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    if !content.is_empty()
                                        && tx
                                            .send(Ok(NormalizedStreamChunk {
                                                visible_text: content.to_string(),
                                                model_thinking: String::new(),
                                                done: false,
                                                usage: extract_usage(&parsed),
                                            }))
                                            .await
                                            .is_err()
                                    {
                                        return;
                                    }
                                }
                            }
                            "chat.end" => {
                                let usage = serde_json::from_str::<Value>(&event_data)
                                    .ok()
                                    .and_then(|payload| extract_usage(&payload));
                                let _ = tx
                                    .send(Ok(NormalizedStreamChunk {
                                        visible_text: String::new(),
                                        model_thinking: String::new(),
                                        done: true,
                                        usage,
                                    }))
                                    .await;
                                return;
                            }
                            "error" => {
                                if let Ok(parsed) = serde_json::from_str::<Value>(&event_data) {
                                    let err_msg = parsed
                                        .get("error")
                                        .and_then(|e| e.get("message"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("Unknown LM Studio error");
                                    let _ = tx
                                        .send(Err(ApiError::Internal(format!(
                                            "LM Studio error: {}",
                                            err_msg
                                        ))))
                                        .await;
                                    return;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Err(err) => {
                    let _ = tx
                        .send(Err(ApiError::Internal(format!(
                            "LM Studio streaming transport failed: {}",
                            err
                        ))))
                        .await;
                    return;
                }
            }
        }

        let _ = tx
            .send(Ok(NormalizedStreamChunk {
                visible_text: String::new(),
                model_thinking: String::new(),
                done: true,
                usage: None,
            }))
            .await;
    });

    Ok(rx)
}

fn build_lmstudio_chat_body(model_name: &str, request: ChatRequest, stream: bool) -> Value {
    let mut system_prompt: Option<String> = None;
    let mut input_items: Vec<Value> = Vec::new();
    for msg in &request.messages {
        if msg.role == "system" {
            system_prompt = Some(msg.content.clone());
        } else {
            input_items.push(json!({
                "type": "message",
                "role": msg.role,
                "content": msg.content
            }));
        }
    }

    let mut body = json!({
        "model": model_name,
        "input": input_items,
        "stream": stream,
    });

    if let Some(obj) = body.as_object_mut() {
        if let Some(ref sp) = system_prompt {
            obj.insert("system_prompt".to_string(), json!(sp));
        }
        if let Some(v) = request.temperature {
            obj.insert("temperature".to_string(), json!(v));
        }
        if let Some(v) = request.top_p {
            obj.insert("top_p".to_string(), json!(v));
        }
        if let Some(v) = request.top_k {
            obj.insert("top_k".to_string(), json!(v));
        }
        if let Some(v) = request.min_p {
            obj.insert("min_p".to_string(), json!(v));
        }
        if let Some(v) = request.repeat_penalty {
            obj.insert("repeat_penalty".to_string(), json!(v));
        }
        if let Some(v) = request.max_tokens {
            obj.insert("max_output_tokens".to_string(), json!(v));
        }
        if let Some(v) = request.seed {
            obj.insert("seed".to_string(), json!(v));
        }
    }

    body
}
