use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::core::errors::ApiError;
use super::types::{ChatRequest, ProviderModel};

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// return the provider name (e.g. "ollama", "lmstudio", "llama_cpp")
    fn name(&self) -> &str;

    /// check if the provider is healthy/reachable
    async fn health_check(&self) -> Result<bool, ApiError>;

    /// list available models from the provider
    async fn list_models(&self) -> Result<Vec<ProviderModel>, ApiError>;

    /// chat completion (non-streaming)
    async fn chat(&self, request: ChatRequest, model_id: &str) -> Result<String, ApiError>;

    /// chat completion (streaming)
    async fn stream_chat(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError>;

    /// generate embeddings
    async fn embed(&self, inputs: &[String], model_id: &str) -> Result<Vec<Vec<f32>>, ApiError>;
}
