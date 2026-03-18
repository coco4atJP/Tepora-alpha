use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::llm::types::{ChatRequest, TokenUsage};
#[cfg(test)]
use crate::llm::types::{NormalizedAssistantTurn, NormalizedStreamChunk};

const DEFAULT_PROCESS_TERMINATE_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_EXTERNAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_EXTERNAL_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(500);
const DEFAULT_STREAM_CHANNEL_BUFFER: usize = 128;
const DEFAULT_STREAM_INTERNAL_BUFFER: usize = 100;

pub(crate) fn process_terminate_timeout(config: &ConfigService) -> Duration {
    if let Ok(config) = config.load_config() {
        if let Some(val) = config
            .get("llm_manager")
            .and_then(|m| m.get("process_terminate_timeout"))
            .and_then(|v| v.as_u64())
        {
            return Duration::from_millis(val);
        }
    }
    DEFAULT_PROCESS_TERMINATE_TIMEOUT
}

pub(crate) fn external_loader_request_timeout(config: &ConfigService) -> Duration {
    if let Ok(config) = config.load_config() {
        if let Some(val) = config
            .get("llm_manager")
            .and_then(|m| {
                m.get("external_request_timeout_ms")
                    .or_else(|| m.get("health_check_timeout"))
            })
            .and_then(|v| v.as_u64())
        {
            return Duration::from_millis(val.max(1));
        }
    }
    DEFAULT_EXTERNAL_REQUEST_TIMEOUT
}

pub(crate) fn external_loader_stream_idle_timeout(config: &ConfigService) -> Duration {
    if let Ok(config) = config.load_config() {
        if let Some(val) = config
            .get("llm_manager")
            .and_then(|m| m.get("stream_idle_timeout_ms"))
            .and_then(|v| v.as_u64())
        {
            return Duration::from_millis(val.max(1));
        }
    }
    DEFAULT_EXTERNAL_STREAM_IDLE_TIMEOUT
}

pub(crate) fn health_check_timeout(config: &ConfigService) -> Duration {
    if let Ok(config) = config.load_config() {
        if let Some(val) = config
            .get("llm_manager")
            .and_then(|m| m.get("health_check_timeout"))
            .and_then(|v| v.as_u64())
        {
            return Duration::from_millis(val.max(1));
        }
    }
    DEFAULT_HEALTH_CHECK_TIMEOUT
}

pub(crate) fn health_check_interval(config: &ConfigService) -> Duration {
    if let Ok(config) = config.load_config() {
        if let Some(val) = config
            .get("llm_manager")
            .and_then(|m| {
                m.get("health_check_interval_ms")
                    .or_else(|| m.get("health_check_interval"))
            })
            .and_then(|v| v.as_u64())
        {
            return Duration::from_millis(val.max(1));
        }
    }
    DEFAULT_HEALTH_CHECK_INTERVAL
}

pub(crate) fn stream_channel_buffer(config: &ConfigService) -> usize {
    if let Ok(config) = config.load_config() {
        if let Some(val) = config
            .get("llm_manager")
            .and_then(|m| m.get("stream_channel_buffer"))
            .and_then(|v| v.as_u64())
        {
            return val.clamp(1, 65_536) as usize;
        }
    }
    DEFAULT_STREAM_CHANNEL_BUFFER
}

pub(crate) fn stream_internal_buffer(config: &ConfigService) -> usize {
    if let Ok(config) = config.load_config() {
        if let Some(val) = config
            .get("llm_manager")
            .and_then(|m| m.get("stream_internal_buffer"))
            .and_then(|v| v.as_u64())
        {
            return val.clamp(1, 65_536) as usize;
        }
    }
    DEFAULT_STREAM_INTERNAL_BUFFER
}

pub(crate) fn build_openai_compatible_chat_body(
    loader: &str,
    model_name: &str,
    request: ChatRequest,
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": model_name,
        "messages": request.messages,
        "stream": stream,
    });

    if let Some(obj) = body.as_object_mut() {
        if let Some(v) = request.temperature {
            obj.insert("temperature".to_string(), json!(v));
        }
        if let Some(v) = request.top_p {
            obj.insert("top_p".to_string(), json!(v));
        }
        if let Some(v) = request.top_k {
            obj.insert("top_k".to_string(), json!(v));
        }
        if let Some(v) = request.repeat_penalty {
            obj.insert("repeat_penalty".to_string(), json!(v));
        }
        if let Some(v) = request.max_tokens {
            obj.insert("max_tokens".to_string(), json!(v));
        }
        if let Some(v) = request.stop {
            obj.insert("stop".to_string(), json!(v));
        }
        if let Some(v) = request.seed {
            obj.insert("seed".to_string(), json!(v));
        }
        if let Some(v) = request.frequency_penalty {
            obj.insert("frequency_penalty".to_string(), json!(v));
        }
        if let Some(v) = request.presence_penalty {
            obj.insert("presence_penalty".to_string(), json!(v));
        }
        if let Some(spec) = request.structured_response {
            obj.insert(
                "response_format".to_string(),
                json!({
                    "type": "json_schema",
                    "json_schema": {
                        "name": spec.name,
                        "schema": spec.schema,
                        "strict": true,
                    }
                }),
            );
        }
        if !stream && loader.eq_ignore_ascii_case("lmstudio") {
            obj.insert(
                "stream_options".to_string(),
                json!({ "include_usage": true }),
            );
        }
    }

    body
}

pub(crate) async fn post_json(
    http: &Client,
    endpoint: &str,
    body: &Value,
    loader: &str,
    base_url: &str,
    request_timeout: Duration,
) -> Result<reqwest::Response, ApiError> {
    let response = http.post(endpoint).json(body);
    tokio::time::timeout(request_timeout, response.send())
        .await
        .map_err(|_| loader_timeout_error(loader, endpoint, request_timeout, "request"))?
        .map_err(|err| unreachable_loader_error(loader, base_url, err))
}

pub(crate) fn extract_field_text(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(candidate) = value.get(*key) {
            let text = value_to_text(candidate);
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    String::new()
}

pub(crate) fn extract_usage(payload: &Value) -> Option<TokenUsage> {
    let usage = payload.get("usage");
    let cached_prompt_tokens = usage
        .and_then(|value| value.get("prompt_tokens_details"))
        .and_then(|value| value.get("cached_tokens"))
        .and_then(|value| value.as_u64())
        .map(|value| value as usize);
    let prompt_tokens = usage
        .and_then(|value| value.get("prompt_tokens"))
        .and_then(|value| value.as_u64())
        .or_else(|| {
            usage
                .and_then(|value| value.get("input_tokens"))
                .and_then(|value| value.as_u64())
        })
        .or_else(|| {
            payload
                .get("prompt_eval_count")
                .and_then(|value| value.as_u64())
        })
        .map(|value| value as usize);
    let completion_tokens = usage
        .and_then(|value| value.get("completion_tokens"))
        .and_then(|value| value.as_u64())
        .or_else(|| {
            usage
                .and_then(|value| value.get("output_tokens"))
                .and_then(|value| value.as_u64())
        })
        .or_else(|| payload.get("eval_count").and_then(|value| value.as_u64()))
        .map(|value| value as usize);
    let total_tokens = usage
        .and_then(|value| value.get("total_tokens"))
        .and_then(|value| value.as_u64())
        .map(|value| value as usize)
        .or_else(|| match (prompt_tokens, completion_tokens) {
            (Some(prompt), Some(completion)) => Some(prompt + completion),
            _ => None,
        });

    if prompt_tokens.is_none() && completion_tokens.is_none() && total_tokens.is_none() {
        None
    } else {
        Some(TokenUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cached_prompt_tokens,
        })
    }
}

pub(crate) fn unreachable_loader_error(
    loader: &str,
    base_url: &str,
    err: reqwest::Error,
) -> ApiError {
    ApiError::Internal(format!(
        "Failed to reach '{}' loader at {}: {}",
        loader, base_url, err
    ))
}

pub(crate) fn loader_timeout_error(
    loader: &str,
    endpoint: &str,
    timeout: Duration,
    phase: &str,
) -> ApiError {
    ApiError::Internal(format!(
        "{} {} timed out after {} ms ({})",
        loader,
        phase,
        timeout.as_millis(),
        endpoint
    ))
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(value_to_text).collect::<Vec<_>>().join(""),
        Value::Object(obj) => {
            for key in ["text", "content", "reasoning", "thinking"] {
                if let Some(candidate) = obj.get(key) {
                    let text = value_to_text(candidate);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

#[cfg(test)]
fn compose_reasoned_content(reasoning: &str, content: &str) -> String {
    if reasoning.trim().is_empty() {
        content.to_string()
    } else if content.is_empty() {
        format!("<think>\n{}\n</think>", reasoning)
    } else {
        format!("<think>\n{}\n</think>\n{}", reasoning, content)
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
struct ThinkTagDecoder {
    buffer: String,
    in_think: bool,
}

#[cfg(test)]
impl ThinkTagDecoder {
    fn push(&mut self, chunk: &str) -> Vec<NormalizedStreamChunk> {
        self.buffer.push_str(chunk);
        let mut out = Vec::new();

        loop {
            if self.in_think {
                if let Some(end) = self.buffer.find("</think>") {
                    let reasoning = self.buffer[..end].to_string();
                    if !reasoning.is_empty() {
                        out.push(NormalizedStreamChunk {
                            visible_text: String::new(),
                            model_thinking: reasoning,
                            done: false,
                            usage: None,
                        });
                    }
                    self.buffer.drain(..end + "</think>".len());
                    self.in_think = false;
                    continue;
                }

                let keep = trailing_prefix_len(&self.buffer, "</think>");
                let emit_len = self.buffer.len().saturating_sub(keep);
                if emit_len == 0 {
                    break;
                }
                let reasoning = self.buffer[..emit_len].to_string();
                self.buffer.drain(..emit_len);
                if !reasoning.is_empty() {
                    out.push(NormalizedStreamChunk {
                        visible_text: String::new(),
                        model_thinking: reasoning,
                        done: false,
                        usage: None,
                    });
                }
                break;
            }

            if let Some(start) = self.buffer.find("<think>") {
                let visible = self.buffer[..start].to_string();
                if !visible.is_empty() {
                    out.push(NormalizedStreamChunk {
                        visible_text: visible,
                        model_thinking: String::new(),
                        done: false,
                        usage: None,
                    });
                }
                self.buffer.drain(..start + "<think>".len());
                self.in_think = true;
                continue;
            }

            let keep = trailing_prefix_len(&self.buffer, "<think>");
            let emit_len = self.buffer.len().saturating_sub(keep);
            if emit_len == 0 {
                break;
            }
            let visible = self.buffer[..emit_len].to_string();
            self.buffer.drain(..emit_len);
            if !visible.is_empty() {
                out.push(NormalizedStreamChunk {
                    visible_text: visible,
                    model_thinking: String::new(),
                    done: false,
                    usage: None,
                });
            }
            break;
        }

        out
    }

    fn finish(&mut self) -> Vec<NormalizedStreamChunk> {
        if self.buffer.is_empty() {
            return Vec::new();
        }

        let chunk = if self.in_think {
            NormalizedStreamChunk {
                visible_text: String::new(),
                model_thinking: self.buffer.clone(),
                done: true,
                usage: None,
            }
        } else {
            NormalizedStreamChunk {
                visible_text: self.buffer.clone(),
                model_thinking: String::new(),
                done: true,
                usage: None,
            }
        };
        self.buffer.clear();
        self.in_think = false;
        vec![chunk]
    }
}

#[cfg(test)]
fn split_reasoned_content(content: &str) -> NormalizedAssistantTurn {
    let mut decoder = ThinkTagDecoder::default();
    let mut normalized = NormalizedAssistantTurn::default();
    for chunk in decoder.push(content).into_iter().chain(decoder.finish()) {
        normalized.visible_text.push_str(&chunk.visible_text);
        normalized.model_thinking.push_str(&chunk.model_thinking);
    }
    normalized.visible_text = normalized.visible_text.trim().to_string();
    normalized.model_thinking = normalized.model_thinking.trim().to_string();
    normalized
}

#[cfg(test)]
fn trailing_prefix_len(buffer: &str, marker: &str) -> usize {
    let max_len = buffer.len().min(marker.len().saturating_sub(1));
    for len in (1..=max_len).rev() {
        if buffer.ends_with(&marker[..len]) {
            return len;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_field_text_supports_reasoning_aliases() {
        let payload = json!({
            "reasoning": [{"text": "step-1"}, {"text": "step-2"}],
            "content": "final"
        });
        assert_eq!(
            extract_field_text(&payload, &["reasoning", "reasoning_content", "thinking"]),
            "step-1step-2"
        );
        assert_eq!(extract_field_text(&payload, &["content"]), "final");
    }

    #[test]
    fn extract_usage_supports_openai_and_ollama_shapes() {
        let openai_payload = json!({
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 8,
                "total_tokens": 20,
                "prompt_tokens_details": {
                    "cached_tokens": 5
                }
            }
        });
        let openai_usage = extract_usage(&openai_payload).expect("openai usage");
        assert_eq!(openai_usage.prompt_tokens, Some(12));
        assert_eq!(openai_usage.completion_tokens, Some(8));
        assert_eq!(openai_usage.total_tokens, Some(20));
        assert_eq!(openai_usage.cached_prompt_tokens, Some(5));

        let ollama_payload = json!({
            "prompt_eval_count": 14,
            "eval_count": 6
        });
        let ollama_usage = extract_usage(&ollama_payload).expect("ollama usage");
        assert_eq!(ollama_usage.prompt_tokens, Some(14));
        assert_eq!(ollama_usage.completion_tokens, Some(6));
        assert_eq!(ollama_usage.total_tokens, Some(20));
        assert_eq!(ollama_usage.cached_prompt_tokens, None);
    }

    #[test]
    fn compose_reasoned_content_wraps_think_block() {
        assert_eq!(
            compose_reasoned_content("chain", "answer"),
            "<think>\nchain\n</think>\nanswer"
        );
        assert_eq!(
            compose_reasoned_content("chain", ""),
            "<think>\nchain\n</think>"
        );
        assert_eq!(compose_reasoned_content("", "answer"), "answer");
    }

    #[test]
    fn split_reasoned_content_separates_visible_and_thinking() {
        let normalized = split_reasoned_content(
            "<think>
chain
</think>
answer",
        );
        assert_eq!(normalized.model_thinking, "chain");
        assert_eq!(normalized.visible_text, "answer");
    }

    #[test]
    fn think_tag_decoder_handles_split_markers() {
        let mut decoder = ThinkTagDecoder::default();
        let mut chunks = Vec::new();
        chunks.extend(decoder.push("<thi"));
        chunks.extend(decoder.push("nk>abc"));
        chunks.extend(decoder.push("</thi"));
        chunks.extend(decoder.push("nk>done"));
        chunks.extend(decoder.finish());

        let reasoning = chunks
            .iter()
            .map(|chunk| chunk.model_thinking.as_str())
            .collect::<String>();
        let visible = chunks
            .iter()
            .map(|chunk| chunk.visible_text.as_str())
            .collect::<String>();
        assert_eq!(reasoning, "abc");
        assert_eq!(visible, "done");
    }
}
