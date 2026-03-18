use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::core::errors::ApiError;
use crate::llm::external_loader_common::{extract_field_text, extract_usage, post_json};
use crate::llm::types::{ChatRequest, NormalizedAssistantTurn, NormalizedStreamChunk};

pub(crate) async fn chat(
    http: &Client,
    base_url: &str,
    model_name: &str,
    request: ChatRequest,
    request_timeout: Duration,
) -> Result<NormalizedAssistantTurn, ApiError> {
    let endpoint = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body = build_ollama_chat_body(model_name, request, false);
    let response = post_json(http, &endpoint, &body, "ollama", base_url, request_timeout).await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "ollama native chat request failed ({}): {}",
            status, text
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let message = payload.get("message").unwrap_or(&Value::Null);
    Ok(NormalizedAssistantTurn {
        visible_text: extract_field_text(message, &["content", "text"]),
        model_thinking: extract_field_text(
            message,
            &["thinking", "reasoning", "reasoning_content"],
        ),
        finish_reason: payload
            .get("done_reason")
            .and_then(|value| value.as_str())
            .map(str::to_string),
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
    buffer_capacity: usize,
) -> Result<mpsc::Receiver<Result<NormalizedStreamChunk, ApiError>>, ApiError> {
    let endpoint = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body = build_ollama_chat_body(model_name, request, true);
    let response = post_json(http, &endpoint, &body, "ollama", base_url, request_timeout).await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "ollama native streaming request failed ({}): {}",
            status, text
        )));
    }

    let (tx, rx) = mpsc::channel(buffer_capacity.max(1));
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
                            "ollama stream idle timeout after {} ms",
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

                    while let Some(newline_index) = buffer.find('\n') {
                        let line = buffer[..newline_index].trim().to_string();
                        buffer = buffer[(newline_index + 1)..].to_string();

                        if line.is_empty() {
                            continue;
                        }

                        let parsed = match serde_json::from_str::<Value>(&line) {
                            Ok(value) => value,
                            Err(err) => {
                                let _ = tx
                                    .send(Err(ApiError::Internal(format!(
                                        "Invalid Ollama streaming payload: {}",
                                        err
                                    ))))
                                    .await;
                                return;
                            }
                        };

                        if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                            let _ = tx.send(Err(ApiError::Internal(err.to_string()))).await;
                            return;
                        }

                        let message = parsed.get("message").unwrap_or(&Value::Null);
                        let reasoning = extract_field_text(
                            message,
                            &["thinking", "reasoning", "reasoning_content"],
                        );
                        let content = extract_field_text(message, &["content", "text"]);
                        let done = parsed.get("done").and_then(|v| v.as_bool()) == Some(true);

                        if (!reasoning.is_empty() || !content.is_empty() || done)
                            && tx
                                .send(Ok(NormalizedStreamChunk {
                                    visible_text: content,
                                    model_thinking: reasoning,
                                    done,
                                    usage: extract_usage(&parsed),
                                }))
                                .await
                                .is_err()
                        {
                            return;
                        }

                        if done {
                            return;
                        }
                    }
                }
                Err(err) => {
                    let _ = tx
                        .send(Err(ApiError::Internal(format!(
                            "Ollama streaming transport failed: {}",
                            err
                        ))))
                        .await;
                    return;
                }
            }
        }

        let trailing = buffer.trim();
        if !trailing.is_empty() {
            if let Ok(parsed) = serde_json::from_str::<Value>(trailing) {
                let message = parsed.get("message").unwrap_or(&Value::Null);
                let reasoning =
                    extract_field_text(message, &["thinking", "reasoning", "reasoning_content"]);
                let content = extract_field_text(message, &["content", "text"]);
                let done = parsed.get("done").and_then(|v| v.as_bool()) == Some(true);

                if !reasoning.is_empty() || !content.is_empty() || done {
                    let _ = tx
                        .send(Ok(NormalizedStreamChunk {
                            visible_text: content,
                            model_thinking: reasoning,
                            done,
                            usage: extract_usage(&parsed),
                        }))
                        .await;
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

fn build_ollama_chat_body(model_name: &str, request: ChatRequest, stream: bool) -> Value {
    let mut body = json!({
        "model": model_name,
        "messages": request.messages,
        "stream": stream,
        "think": true,
    });

    if let Some(obj) = body.as_object_mut() {
        let mut options = serde_json::Map::new();
        if let Some(v) = request.temperature {
            options.insert("temperature".to_string(), json!(v));
        }
        if let Some(v) = request.top_p {
            options.insert("top_p".to_string(), json!(v));
        }
        if let Some(v) = request.top_k {
            options.insert("top_k".to_string(), json!(v));
        }
        if let Some(v) = request.repeat_penalty {
            options.insert("repeat_penalty".to_string(), json!(v));
        }
        if let Some(v) = request.max_tokens {
            options.insert("num_predict".to_string(), json!(v));
        }
        if let Some(v) = request.seed {
            options.insert("seed".to_string(), json!(v));
        }
        if let Some(v) = request.frequency_penalty {
            options.insert("frequency_penalty".to_string(), json!(v));
        }
        if let Some(v) = request.presence_penalty {
            options.insert("presence_penalty".to_string(), json!(v));
        }
        if let Some(v) = request.min_p {
            options.insert("min_p".to_string(), json!(v));
        }
        if let Some(v) = request.tfs_z {
            options.insert("tfs_z".to_string(), json!(v));
        }
        if let Some(v) = request.typical_p {
            options.insert("typical_p".to_string(), json!(v));
        }
        if let Some(v) = request.mirostat {
            options.insert("mirostat".to_string(), json!(v));
        }
        if let Some(v) = request.mirostat_tau {
            options.insert("mirostat_tau".to_string(), json!(v));
        }
        if let Some(v) = request.mirostat_eta {
            options.insert("mirostat_eta".to_string(), json!(v));
        }
        if let Some(v) = request.repeat_last_n {
            options.insert("repeat_last_n".to_string(), json!(v));
        }
        if let Some(v) = request.penalize_nl {
            options.insert("penalize_newline".to_string(), json!(v));
        }
        if let Some(v) = request.num_ctx {
            options.insert("num_ctx".to_string(), json!(v));
        }
        if !options.is_empty() {
            obj.insert("options".to_string(), Value::Object(options));
        }
        if let Some(v) = request.stop {
            obj.insert("stop".to_string(), json!(v));
        }
    }

    body
}
