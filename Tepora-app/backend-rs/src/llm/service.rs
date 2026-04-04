use reqwest::Client;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::llm::external_loader_common::{
    external_loader_request_timeout, external_loader_stream_idle_timeout,
    process_terminate_timeout, stream_channel_buffer, stream_internal_buffer,
};
use crate::llm::llama_service::LlamaService;
use crate::llm::lmstudio_native_client;
use crate::llm::model_resolution::{resolve_model_target, ModelExecutionTarget};
use crate::llm::ollama_native_client;
use crate::llm::openai_compatible_client;
use crate::llm::types::{ChatMessage, ChatRequest, NormalizedAssistantTurn, NormalizedStreamChunk};
use crate::models::ModelManager;

#[derive(Clone)]
pub struct LlmService {
    models: ModelManager,
    llama: LlamaService,
    config: ConfigService,
    http: Client,
}

impl LlmService {
    pub fn new(models: ModelManager, llama: LlamaService, config: ConfigService) -> Self {
        Self {
            models,
            llama,
            config,
            http: Client::new(),
        }
    }

    pub async fn chat(&self, request: ChatRequest, model_id: &str) -> Result<String, ApiError> {
        Ok(self.chat_normalized(request, model_id).await?.visible_text)
    }

    pub async fn chat_normalized(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<NormalizedAssistantTurn, ApiError> {
        let request = normalize_request(request);
        let message_count = request.messages.len();
        let target = resolve_model_target(&self.models, &self.config, model_id, &request)?;
        let result = match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = process_terminate_timeout(&self.config);
                self.llama
                    .chat_normalized(&config, clone_messages(&request), timeout)
                    .await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                let request_timeout = external_loader_request_timeout(&self.config);
                if loader.eq_ignore_ascii_case("ollama") {
                    match ollama_native_client::chat(
                        &self.http,
                        &base_url,
                        &model_name,
                        request.clone(),
                        request_timeout,
                    )
                    .await
                    {
                        Ok(content) => Ok(content),
                        Err(err) => {
                            tracing::warn!(
                                "Ollama native chat failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            openai_compatible_client::chat(
                                &self.http,
                                &loader,
                                &base_url,
                                &model_name,
                                request,
                                request_timeout,
                            )
                            .await
                        }
                    }
                } else if loader.eq_ignore_ascii_case("lmstudio") {
                    match lmstudio_native_client::chat(
                        &self.http,
                        &base_url,
                        &model_name,
                        request.clone(),
                        request_timeout,
                    )
                    .await
                    {
                        Ok(content) => Ok(content),
                        Err(err) => {
                            tracing::warn!(
                                "LM Studio native chat failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            openai_compatible_client::chat(
                                &self.http,
                                &loader,
                                &base_url,
                                &model_name,
                                request,
                                request_timeout,
                            )
                            .await
                        }
                    }
                } else {
                    openai_compatible_client::chat(
                        &self.http,
                        &loader,
                        &base_url,
                        &model_name,
                        request,
                        request_timeout,
                    )
                    .await
                }
            }
        }?;
        trace_chat_usage(model_id, message_count, &result);
        Ok(result)
    }

    pub async fn stream_chat(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let mut normalized = self.stream_chat_normalized(request, model_id).await?;
        let (tx, rx) = mpsc::channel(stream_channel_buffer(&self.config));
        tokio::spawn(async move {
            while let Some(item) = normalized.recv().await {
                match item {
                    Ok(chunk) => {
                        if !chunk.visible_text.is_empty()
                            && tx.send(Ok(chunk.visible_text)).await.is_err()
                        {
                            return;
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(Err(err)).await;
                        return;
                    }
                }
            }
        });
        Ok(rx)
    }

    pub async fn stream_chat_normalized(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<NormalizedStreamChunk, ApiError>>, ApiError> {
        let request = normalize_request(request);
        let target = resolve_model_target(&self.models, &self.config, model_id, &request)?;
        match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = process_terminate_timeout(&self.config);
                self.llama
                    .stream_chat_normalized(&config, clone_messages(&request), timeout)
                    .await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                let request_timeout = external_loader_request_timeout(&self.config);
                let stream_idle_timeout = external_loader_stream_idle_timeout(&self.config);
                let internal_buffer = stream_internal_buffer(&self.config);
                if loader.eq_ignore_ascii_case("ollama") {
                    match ollama_native_client::stream_chat(
                        &self.http,
                        &base_url,
                        &model_name,
                        request.clone(),
                        request_timeout,
                        stream_idle_timeout,
                        internal_buffer,
                    )
                    .await
                    {
                        Ok(stream) => Ok(stream),
                        Err(err) => {
                            tracing::warn!(
                                "Ollama native stream failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            openai_compatible_client::stream_chat(
                                &self.http,
                                &loader,
                                &base_url,
                                &model_name,
                                request,
                                request_timeout,
                                stream_idle_timeout,
                                internal_buffer,
                            )
                            .await
                        }
                    }
                } else if loader.eq_ignore_ascii_case("lmstudio") {
                    match lmstudio_native_client::stream_chat(
                        &self.http,
                        &base_url,
                        &model_name,
                        request.clone(),
                        request_timeout,
                        stream_idle_timeout,
                        internal_buffer,
                    )
                    .await
                    {
                        Ok(stream) => Ok(stream),
                        Err(err) => {
                            tracing::warn!(
                                "LM Studio native stream failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            openai_compatible_client::stream_chat(
                                &self.http,
                                &loader,
                                &base_url,
                                &model_name,
                                request,
                                request_timeout,
                                stream_idle_timeout,
                                internal_buffer,
                            )
                            .await
                        }
                    }
                } else {
                    openai_compatible_client::stream_chat(
                        &self.http,
                        &loader,
                        &base_url,
                        &model_name,
                        request,
                        request_timeout,
                        stream_idle_timeout,
                        internal_buffer,
                    )
                    .await
                }
            }
        }
    }

    pub async fn embed(
        &self,
        inputs: &[String],
        model_id: &str,
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        let target = resolve_model_target(
            &self.models,
            &self.config,
            model_id,
            &ChatRequest::new(vec![]),
        )?;
        match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = process_terminate_timeout(&self.config);
                self.llama.embed(&config, inputs, timeout).await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                let request_timeout = external_loader_request_timeout(&self.config);
                openai_compatible_client::embed(
                    &self.http,
                    &loader,
                    &base_url,
                    &model_name,
                    inputs,
                    request_timeout,
                )
                .await
            }
        }
    }

    pub async fn get_logprobs(
        &self,
        text: &str,
        model_id: &str,
    ) -> Result<Vec<(String, f64)>, ApiError> {
        let request = ChatRequest::new(vec![]);
        let target = resolve_model_target(&self.models, &self.config, model_id, &request)?;
        match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = process_terminate_timeout(&self.config);
                self.llama.get_logprobs(&config, text, timeout).await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                let request_timeout = external_loader_request_timeout(&self.config);
                openai_compatible_client::get_logprobs(
                    &self.http,
                    &loader,
                    &base_url,
                    &model_name,
                    text,
                    request_timeout,
                )
                .await
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), ApiError> {
        let timeout = process_terminate_timeout(&self.config);
        self.llama.stop(timeout).await
    }

    pub async fn chat_structured<T>(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<T, ApiError>
    where
        T: DeserializeOwned,
    {
        let Some(spec) = request.structured_response.clone() else {
            return Err(ApiError::Internal(
                "chat_structured requires structured_response".to_string(),
            ));
        };

        let first = self.chat(request.clone(), model_id).await?;
        if let Ok(parsed) = parse_structured_response::<T>(&first) {
            tracing::debug!(
                model_id = %model_id,
                schema = %spec.name,
                structured_repair_count = 0,
                "structured chat parsed without repair"
            );
            return Ok(parsed);
        }

        let repair_request = ChatRequest::new(vec![
            ChatMessage::new_text(
                "system",
                "Repair the assistant response so it strictly matches the provided JSON schema. Return only valid JSON.",
            ),
            ChatMessage::new_text(
                "user",
                format!(
                    "Schema name: {}\nSchema:\n{}\n\nOriginal response:\n{}\n\nReturn corrected JSON only.",
                    spec.name,
                    serde_json::to_string_pretty(&spec.schema).unwrap_or_else(|_| spec.schema.to_string()),
                    first
                ),
            ),
        ])
        .with_structured_response(spec);

        let repaired = self.chat(repair_request, model_id).await?;
        match parse_structured_response::<T>(&repaired) {
            Ok(parsed) => {
                tracing::debug!(
                    model_id = %model_id,
                    structured_repair_count = 1,
                    "structured chat repaired successfully"
                );
                Ok(parsed)
            }
            Err(err) => {
                tracing::warn!(
                    model_id = %model_id,
                    structured_repair_count = 1,
                    error = %err,
                    "structured chat validation failed after repair"
                );
                Err(ApiError::Internal(format!(
                    "Structured response validation failed after repair: {err}"
                )))
            }
        }
    }
}

fn clone_messages(request: &ChatRequest) -> Vec<ChatMessage> {
    request.messages.clone()
}

fn normalize_request(mut request: ChatRequest) -> ChatRequest {
    request.messages = normalize_messages(std::mem::take(&mut request.messages));
    request
}

fn normalize_messages(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut system_parts = Vec::new();
    let mut others = Vec::new();

    for message in messages {
        if message.role == "system" {
            let text = message.text_content();
            if !text.trim().is_empty() {
                system_parts.push(text.to_string());
            }
        } else if !message.text_content().trim().is_empty() {
            others.push(message);
        }
    }

    let mut normalized = Vec::new();
    if !system_parts.is_empty() {
        normalized.push(ChatMessage::new_text("system", system_parts.join("\n\n")));
    }
    normalized.extend(others);
    normalized
}

fn parse_structured_response<T>(text: &str) -> Result<T, serde_json::Error>
where
    T: DeserializeOwned,
{
    if let Ok(parsed) = serde_json::from_str::<T>(text.trim()) {
        return Ok(parsed);
    }

    let value = parse_json_value_from_text(text)?;
    serde_json::from_value(value)
}

fn parse_json_value_from_text(text: &str) -> Result<Value, serde_json::Error> {
    if let Ok(parsed) = serde_json::from_str::<Value>(text.trim()) {
        return Ok(parsed);
    }

    let trimmed = text.trim();
    let Some(start) = trimmed.find(['{', '[']) else {
        return serde_json::from_str::<Value>(trimmed);
    };
    let Some(end) = trimmed.rfind([']', '}']) else {
        return serde_json::from_str::<Value>(trimmed);
    };
    serde_json::from_str::<Value>(&trimmed[start..=end])
}

fn trace_chat_usage(model_id: &str, message_count: usize, turn: &NormalizedAssistantTurn) {
    if !tracing::enabled!(tracing::Level::DEBUG) {
        return;
    }
    tracing::debug!(
        model_id = %model_id,
        message_count,
        prompt_tokens = turn.usage.as_ref().and_then(|usage| usage.prompt_tokens),
        completion_tokens = turn.usage.as_ref().and_then(|usage| usage.completion_tokens),
        total_tokens = turn.usage.as_ref().and_then(|usage| usage.total_tokens),
        cached_prompt_tokens = turn
            .usage
            .as_ref()
            .and_then(|usage| usage.cached_prompt_tokens),
        "llm chat normalized"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_messages_merges_system_messages_in_order() {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "first".to_string(),
                multimodal_parts: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: "bundle".to_string(),
                multimodal_parts: None,
            },
            ChatMessage {
                role: "system".to_string(),
                content: "second".to_string(),
                multimodal_parts: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: "final".to_string(),
                multimodal_parts: None,
            },
        ];

        let normalized = normalize_messages(messages);
        assert_eq!(normalized.len(), 3);
        assert_eq!(normalized[0].role, "system");
        assert_eq!(normalized[0].text_content(), "first\n\nsecond");
        assert_eq!(normalized[1].text_content(), "bundle");
        assert_eq!(normalized[2].text_content(), "final");
    }

    #[test]
    fn parse_structured_response_accepts_embedded_json() {
        let parsed = parse_structured_response::<Vec<String>>("Here you go: [\"alpha\", \"beta\"]")
            .expect("embedded JSON should parse");

        assert_eq!(parsed, vec!["alpha".to_string(), "beta".to_string()]);
    }
}
