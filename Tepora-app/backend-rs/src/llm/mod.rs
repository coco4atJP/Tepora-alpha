#[allow(dead_code)]
pub mod provider;
pub mod types;
pub mod ollama;
pub mod lmstudio;
pub mod llama_cpp;

use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::core::errors::ApiError;
use self::provider::LlmProvider;
use self::types::ChatRequest;

use std::sync::Arc;
use tokio::sync::RwLock;
use crate::models::ModelManager;
use crate::core::config::ConfigService;

#[derive(Clone)]
pub struct LlmService {
    providers: Arc<RwLock<HashMap<String, Box<dyn LlmProvider>>>>,
    models: ModelManager,
}

impl LlmService {
    pub fn new(models: ModelManager, llama_service: crate::llama::LlamaService, config: ConfigService) -> Result<Self, ApiError> {
        // Load config to get base URLs
        let config_val = config.load_config().unwrap_or(serde_json::Value::Null);
        let loaders = config_val.get("loaders");
        
        let ollama_url = loaders
            .and_then(|l| l.get("ollama"))
            .and_then(|c| c.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or("http://localhost:11434")
            .to_string();

        let lmstudio_url = loaders
            .and_then(|l| l.get("lmstudio"))
            .and_then(|c| c.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or("http://localhost:1234")
            .to_string();

        // Create providers
        let ollama = ollama::OllamaProvider::new(ollama_url);
        let lmstudio = lmstudio::LmStudioProvider::new(lmstudio_url);
        let llama_cpp = llama_cpp::LlamaCppProvider::new(llama_service, Arc::new(models.clone()));

        let mut map: HashMap<String, Box<dyn LlmProvider>> = HashMap::new();
        map.insert(ollama.name().to_string(), Box::new(ollama));
        map.insert(lmstudio.name().to_string(), Box::new(lmstudio));
        map.insert(llama_cpp.name().to_string(), Box::new(llama_cpp));

        Ok(Self {
            providers: Arc::new(RwLock::new(map)),
            models,
        })
    }



    fn resolve_provider(&self, model_id: &str) -> Option<String> {
        // First check if model exists in registry and has a specific loader
        if let Ok(Some(entry)) = self.models.get_model(model_id) {
            if !entry.loader.is_empty() {
                return Some(entry.loader);
            }
        }

        // Fallback to ID prefix
        if model_id.starts_with("ollama-") {
            Some("ollama".to_string())
        } else if model_id.starts_with("lmstudio-") {
            Some("lmstudio".to_string())
        } else {
            // Default to llama_cpp
            Some("llama_cpp".to_string())
        }
    }

    pub async fn chat(&self, request: ChatRequest, model_id: &str) -> Result<String, ApiError> {
        let provider_name = self.resolve_provider(model_id)
            .ok_or_else(|| ApiError::NotFound(format!("No provider found for model '{}'", model_id)))?;
        
        let providers = self.providers.read().await;
        if let Some(provider) = providers.get(&provider_name) {
            provider.chat(request, model_id).await
        } else {
            Err(ApiError::Internal(format!("Provider '{}' not found", provider_name)))
        }
    }

    pub async fn stream_chat(&self, request: ChatRequest, model_id: &str) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let provider_name = self.resolve_provider(model_id)
            .ok_or_else(|| ApiError::NotFound(format!("No provider found for model '{}'", model_id)))?;

        let providers = self.providers.read().await;
        if let Some(provider) = providers.get(&provider_name) {
            provider.stream_chat(request, model_id).await
        } else {
            Err(ApiError::Internal(format!("Provider '{}' not found", provider_name)))
        }
    }

    #[allow(dead_code)]
    pub async fn embed(&self, inputs: &[String], model_id: &str) -> Result<Vec<Vec<f32>>, ApiError> {
        let provider_name = self.resolve_provider(model_id)
            .ok_or_else(|| ApiError::NotFound(format!("No provider found for model '{}'", model_id)))?;

        let providers = self.providers.read().await;
        if let Some(provider) = providers.get(&provider_name) {
            provider.embed(inputs, model_id).await
        } else {
            Err(ApiError::Internal(format!("Provider '{}' not found", provider_name)))
        }
    }
    
    // Helper to list all models from all providers
    #[allow(dead_code)]
    pub async fn list_all_models(&self) -> HashMap<String, Vec<types::ProviderModel>> {
        let mut results = HashMap::new();
        let providers = self.providers.read().await;
        for (name, provider) in providers.iter() {
            if let Ok(models) = provider.list_models().await {
                results.insert(name.clone(), models);
            }
        }
        results
    }
}

#[cfg(test)]
mod tests;
