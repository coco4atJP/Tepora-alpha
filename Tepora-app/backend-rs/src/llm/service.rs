use std::path::PathBuf;

use tokio::sync::mpsc;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::llm::llama_service::LlamaService;
use crate::llm::types::{ChatMessage, ChatRequest};
use crate::models::types::ModelRuntimeConfig;
use crate::models::ModelManager;

#[derive(Clone)]
pub struct LlmService {
    models: ModelManager,
    llama: LlamaService,
    config: ConfigService,
}

impl LlmService {
    pub fn new(models: ModelManager, llama: LlamaService, config: ConfigService) -> Self {
        Self {
            models,
            llama,
            config,
        }
    }

    pub async fn chat(&self, request: ChatRequest, model_id: &str) -> Result<String, ApiError> {
        let config = self.resolve_model_config(model_id, &request)?;
        let timeout = self.get_process_terminate_timeout();

        let messages = request
            .messages
            .iter()
            .map(|m| ChatMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect();

        self.llama.chat(&config, messages, timeout).await
    }

    pub async fn stream_chat(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let config = self.resolve_model_config(model_id, &request)?;
        let timeout = self.get_process_terminate_timeout();

        let messages = request
            .messages
            .iter()
            .map(|m| ChatMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect();

        self.llama.stream_chat(&config, messages, timeout).await
    }

    pub async fn embed(
        &self,
        inputs: &[String],
        model_id: &str,
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        // Create dummy request to resolve config
        let request = ChatRequest::new(vec![]);
        let config = self.resolve_model_config(model_id, &request)?;
        let timeout = self.get_process_terminate_timeout();

        self.llama.embed(&config, inputs, timeout).await
    }

    fn get_process_terminate_timeout(&self) -> std::time::Duration {
        if let Ok(config) = self.config.load_config() {
            if let Some(val) = config
                .get("llm_manager")
                .and_then(|m| m.get("process_terminate_timeout"))
                .and_then(|v| v.as_u64())
            {
                return std::time::Duration::from_millis(val);
            }
        }
        std::time::Duration::from_secs(5)
    }

    fn resolve_model_config(
        &self,
        model_id: &str,
        request: &ChatRequest,
    ) -> Result<ModelRuntimeConfig, ApiError> {
        // 1. Get model from registry to find file path
        let model_entry = self
            .models
            .get_model(model_id)?
            .ok_or_else(|| ApiError::BadRequest(format!("Model not found: {}", model_id)))?;

        // 2. Load global config defaults
        let app_config = self.config.load_config().unwrap_or(serde_json::Value::Null);
        // We can look at "models_gguf.text_model" to get defaults like n_ctx, gpu params
        // Or just use defaults

        let models_config = app_config.get("models_gguf");
        let text_model_defaults = models_config.and_then(|m| m.get("text_model"));
        let embedding_model_defaults = models_config.and_then(|m| m.get("embedding_model"));

        let defaults = if model_entry.role == "embedding" {
            embedding_model_defaults
        } else {
            text_model_defaults
        };

        let n_ctx = defaults
            .and_then(|v| v.get("n_ctx").and_then(|x| x.as_u64()))
            .unwrap_or(2048) as usize;
        let n_gpu_layers = defaults
            .and_then(|v| v.get("n_gpu_layers").and_then(|x| x.as_i64()))
            .unwrap_or(-1) as i32;
        let port = defaults
            .and_then(|v| v.get("port").and_then(|x| x.as_u64()))
            .unwrap_or(if model_entry.role == "embedding" {
                8090
            } else {
                8088
            }) as u16;

        // 3. Override with request params
        let predict_len = request.max_tokens.map(|v| v as usize);
        let temperature = request.temperature.map(|v| v as f32);
        let top_p = request.top_p.map(|v| v as f32);
        let top_k = request.top_k.map(|v| v as i32);
        let repeat_penalty = request.repeat_penalty.map(|v| v as f32);

        Ok(ModelRuntimeConfig {
            model_key: model_id.to_string(),
            model_path: PathBuf::from(model_entry.file_path),
            port,
            n_ctx,
            n_gpu_layers,
            predict_len,
            temperature,
            top_p,
            top_k,
            repeat_penalty,
        })
    }
}
