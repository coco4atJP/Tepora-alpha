use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::core::errors::ApiError;
use crate::llm::external_loader_common::{
    build_openai_compatible_chat_body, extract_field_text, extract_usage, post_json,
};
use crate::llm::types::{ChatRequest, NormalizedAssistantTurn, NormalizedStreamChunk};

pub(crate) async fn chat(
    http: &Client,
    loader: &str,
    base_url: &str,
    model_name: &str,
    request: ChatRequest,
    request_timeout: Duration,
) -> Result<NormalizedAssistantTurn, ApiError> {
    let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let body = build_openai_compatible_chat_body(loader, model_name, request, false);
    let response = post_json(http, &endpoint, &body, loader, base_url, request_timeout).await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "{} chat request failed ({}): {}",
            loader, status, text
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let choice = payload
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first());
    let message = choice
        .and_then(|choice| choice.get("message"))
        .unwrap_or(&Value::Null);

    Ok(NormalizedAssistantTurn {
        visible_text: extract_field_text(message, &["content", "text"]),
        model_thinking: extract_field_text(
            message,
            &["reasoning", "reasoning_content", "thinking"],
        ),
        finish_reason: choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        usage: extract_usage(&payload),
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn stream_chat(
    http: &Client,
    loader: &str,
    base_url: &str,
    model_name: &str,
    request: ChatRequest,
    request_timeout: Duration,
    stream_idle_timeout: Duration,
    buffer_capacity: usize,
) -> Result<mpsc::Receiver<Result<NormalizedStreamChunk, ApiError>>, ApiError> {
    let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let body = build_openai_compatible_chat_body(loader, model_name, request, true);
    let response = post_json(http, &endpoint, &body, loader, base_url, request_timeout).await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "{} streaming request failed ({}): {}",
            loader, status, text
        )));
    }

    let (tx, rx) = mpsc::channel(buffer_capacity.max(1));
    let mut byte_stream = response.bytes_stream();
    let loader_name = loader.to_string();
    tokio::spawn(async move {
        let mut buffer = String::new();
        loop {
            let next = tokio::time::timeout(stream_idle_timeout, byte_stream.next()).await;
            let next = match next {
                Ok(value) => value,
                Err(_) => {
                    let _ = tx
                        .send(Err(ApiError::Internal(format!(
                            "{} stream idle timeout after {} ms",
                            loader_name,
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
                        if line == "data: [DONE]" {
                            let _ = tx
                                .send(Ok(NormalizedStreamChunk {
                                    visible_text: String::new(),
                                    model_thinking: String::new(),
                                    done: true,
                                    usage: None,
                                }))
                                .await;
                            return;
                        }

                        let Some(data) = line.strip_prefix("data: ") else {
                            continue;
                        };
                        let parsed = match serde_json::from_str::<Value>(data) {
                            Ok(value) => value,
                            Err(err) => {
                                let _ = tx
                                    .send(Err(ApiError::Internal(format!(
                                        "Invalid streaming payload: {}",
                                        err
                                    ))))
                                    .await;
                                return;
                            }
                        };

                        if emit_openai_stream_chunk(&tx, &parsed).await.is_err() {
                            return;
                        }
                    }
                }
                Err(err) => {
                    let _ = tx
                        .send(Err(ApiError::Internal(format!(
                            "Streaming transport failed: {}",
                            err
                        ))))
                        .await;
                    return;
                }
            }
        }

        let trailing = buffer.trim();
        if !trailing.is_empty() && trailing != "data: [DONE]" {
            if let Some(data) = trailing.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    let _ = emit_openai_stream_chunk(&tx, &parsed).await;
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

pub(crate) async fn embed(
    http: &Client,
    loader: &str,
    base_url: &str,
    model_name: &str,
    inputs: &[String],
    request_timeout: Duration,
) -> Result<Vec<Vec<f32>>, ApiError> {
    let endpoint = format!("{}/v1/embeddings", base_url.trim_end_matches('/'));
    let body = json!({
        "model": model_name,
        "input": inputs,
    });
    let response = post_json(http, &endpoint, &body, loader, base_url, request_timeout).await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "{} embedding request failed ({}): {}",
            loader, status, text
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let mut embeddings = Vec::new();
    if let Some(items) = payload.get("data").and_then(|v| v.as_array()) {
        for item in items {
            let vector = item
                .get("embedding")
                .and_then(|v| v.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_f64().map(|f| f as f32))
                        .collect::<Vec<f32>>()
                })
                .unwrap_or_default();
            embeddings.push(vector);
        }
    }
    Ok(embeddings)
}

pub(crate) async fn get_logprobs(
    http: &Client,
    loader: &str,
    base_url: &str,
    model_name: &str,
    text: &str,
    request_timeout: Duration,
) -> Result<Vec<(String, f64)>, ApiError> {
    let endpoint = format!("{}/v1/completions", base_url.trim_end_matches('/'));
    let body = json!({
        "model": model_name,
        "prompt": text,
        "max_tokens": 1,
        "logprobs": 1,
        "echo": true,
    });
    let response = post_json(http, &endpoint, &body, loader, base_url, request_timeout).await?;

    if !response.status().is_success() {
        let status = response.status();
        let err_text = response.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "{} logprobs request failed ({}): {}",
            loader, status, err_text
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let mut result = Vec::new();

    if let Some(choices) = payload.get("choices").and_then(|v| v.as_array()) {
        if let Some(first_choice) = choices.first() {
            if let Some(logprobs) = first_choice.get("logprobs") {
                let tokens = logprobs.get("tokens").and_then(|v| v.as_array());
                let token_logprobs = logprobs.get("token_logprobs").and_then(|v| v.as_array());

                if let (Some(ts), Some(lps)) = (tokens, token_logprobs) {
                    for (token_val, logprob_val) in ts.iter().zip(lps.iter()) {
                        let token_str = token_val.as_str().unwrap_or("").to_string();
                        let logprob_f64 = logprob_val.as_f64().unwrap_or(0.0);
                        result.push((token_str, logprob_f64));
                    }
                }
            }
        }
    }

    if result.is_empty() {
        return Err(ApiError::Internal(format!(
            "{} did not return valid logprobs in the response.",
            loader
        )));
    }

    Ok(result)
}

async fn emit_openai_stream_chunk(
    tx: &mpsc::Sender<Result<NormalizedStreamChunk, ApiError>>,
    parsed: &Value,
) -> Result<(), ()> {
    let delta = parsed
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"));

    let reasoning = delta
        .map(|d| extract_field_text(d, &["reasoning", "reasoning_content", "thinking"]))
        .unwrap_or_default();
    let content = delta
        .map(|d| extract_field_text(d, &["content", "text"]))
        .unwrap_or_default();

    if !reasoning.is_empty() || !content.is_empty() {
        tx.send(Ok(NormalizedStreamChunk {
            visible_text: content,
            model_thinking: reasoning,
            done: false,
            usage: extract_usage(parsed),
        }))
        .await
        .map_err(|_| ())?;
    }

    Ok(())
}
