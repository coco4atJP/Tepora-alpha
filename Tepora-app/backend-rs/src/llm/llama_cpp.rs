use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::mpsc;
use serde_json::json;

use crate::core::errors::ApiError;
use crate::llama::LlamaService;
use crate::models::ModelManager;


use super::provider::LlmProvider;
use super::types::{ChatRequest, ProviderModel};

#[derive(Clone)]
pub struct LlamaCppProvider {
    service: LlamaService,
    models: Arc<ModelManager>,
}

impl LlamaCppProvider {
    pub fn new(service: LlamaService, models: Arc<ModelManager>) -> Self {
        Self {
            service,
            models,
        }
    }

    // Helper to construct configuration value expected by LlamaService
    fn build_config(&self, model_id: &str, request: &ChatRequest) -> Result<serde_json::Value, ApiError> {
        let entry = self.models.get_model(model_id)?.ok_or_else(|| {
            ApiError::NotFound(format!("Model '{}' not found", model_id))
        })?;


        let mut model_config = json!({
            "path": entry.file_path,
            "port": 0, 
            "n_ctx": 4096,
            "n_gpu_layers": -1,
        });

        if let Some(obj) = model_config.as_object_mut() {
            if let Some(t) = request.temperature { obj.insert("temperature".to_string(), json!(t)); }
            if let Some(t) = request.top_p { obj.insert("top_p".to_string(), json!(t)); }
            if let Some(t) = request.top_k { obj.insert("top_k".to_string(), json!(t)); }
            if let Some(t) = request.repeat_penalty { obj.insert("repeat_penalty".to_string(), json!(t)); }
            // LlamaService specific checks
        }

        // The key used in LlamaService is determined by role. 
        // We wrap this in the structure expected by ModelRuntimeConfig::from_role
        // However, ModelRuntimeConfig::for_chat checks "text_model" key.
        Ok(json!({
            "models_gguf": {
                "text_model": model_config,
                "embedding_model": model_config.clone() // reuse for simplicity if embed called
            }
        }))
    }
}

#[async_trait]
impl LlmProvider for LlamaCppProvider {
    fn name(&self) -> &str {
        "llama_cpp"
    }

    async fn health_check(&self) -> Result<bool, ApiError> {
        Ok(true) // Assumed always 'available' as it is embedded
    }

    async fn list_models(&self) -> Result<Vec<ProviderModel>, ApiError> {
        // Models are managed by ModelManager, not listed dynamically from a backend
        Ok(Vec::new())
    }

    async fn chat(&self, request: ChatRequest, model_id: &str) -> Result<String, ApiError> {
        let config = self.build_config(model_id, &request)?;
        
        let messages = request.messages.into_iter().map(|m| crate::llama::ChatMessage {
            role: m.role,
            content: m.content,
        }).collect();

        self.service.chat(&config, messages).await
    }

    async fn stream_chat(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let config = self.build_config(model_id, &request)?;

        let messages = request.messages.into_iter().map(|m| crate::llama::ChatMessage {
            role: m.role,
            content: m.content,
        }).collect();

        self.service.stream_chat(&config, messages).await
    }

    async fn embed(&self, inputs: &[String], model_id: &str) -> Result<Vec<Vec<f32>>, ApiError> {
        let config = self.build_config(model_id, &ChatRequest {
            messages: vec![],
            temperature: None, top_p: None, top_k: None, repeat_penalty: None, max_tokens: None, stop: None
        })?;

        self.service.embed(&config, inputs).await
    }
}
