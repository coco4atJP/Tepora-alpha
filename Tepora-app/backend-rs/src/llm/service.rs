use reqwest::Client;
use tokio::sync::mpsc;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::llm::external_loader_common::{
    external_loader_request_timeout, external_loader_stream_idle_timeout, process_terminate_timeout,
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
        let target = resolve_model_target(&self.models, &self.config, model_id, &request)?;
        match target {
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
        }
    }

    pub async fn stream_chat(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let mut normalized = self.stream_chat_normalized(request, model_id).await?;
        let (tx, rx) = mpsc::channel(128);
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
                if loader.eq_ignore_ascii_case("ollama") {
                    match ollama_native_client::stream_chat(
                        &self.http,
                        &base_url,
                        &model_name,
                        request.clone(),
                        request_timeout,
                        stream_idle_timeout,
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
}

fn clone_messages(request: &ChatRequest) -> Vec<ChatMessage> {
    request
        .messages
        .iter()
        .map(|m| ChatMessage {
            role: m.role.clone(),
            content: m.content.clone(),
        })
        .collect()
}
