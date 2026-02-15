use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct OllamaTagsResponse {
    pub models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub digest: String,
}

#[derive(Debug, Deserialize)]
pub struct OpenAiModelsResponse {
    pub data: Vec<OpenAiModelInfo>,
}

#[derive(Debug, Deserialize)]
pub struct OpenAiModelInfo {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    pub role: String,
    pub file_size: u64,
    pub filename: String,
    pub source: String,
    pub file_path: String,
    #[serde(default)]
    pub loader: String,
    #[serde(default)]
    pub loader_model_name: Option<String>,
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelRegistry {
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    #[serde(default)]
    pub role_assignments: HashMap<String, String>,
    #[serde(default)]
    pub role_order: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ModelDownloadPolicy {
    pub allowed: bool,
    pub requires_consent: bool,
    pub warnings: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ModelDownloadResult {
    pub success: bool,
    pub requires_consent: bool,
    pub warnings: Vec<String>,
    pub path: Option<PathBuf>,
    pub error_message: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRuntimeConfig {
    pub model_key: String,
    pub model_path: PathBuf,
    pub port: u16,
    pub n_ctx: usize,
    pub n_gpu_layers: i32,
    pub predict_len: Option<usize>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<i32>,
    pub repeat_penalty: Option<f32>,
}

impl ModelRuntimeConfig {
    pub fn for_chat(config: &serde_json::Value) -> Result<Self, crate::core::errors::ApiError> {
        Self::from_config(config, "text_model")
    }

    pub fn for_embedding(
        config: &serde_json::Value,
    ) -> Result<Self, crate::core::errors::ApiError> {
        Self::from_config(config, "embedding_model")
    }

    fn from_config(
        config: &serde_json::Value,
        role_key: &str,
    ) -> Result<Self, crate::core::errors::ApiError> {
        let models = config.get("models_gguf").and_then(|v| v.as_object());
        let model_cfg = models
            .and_then(|m| m.get(role_key))
            .unwrap_or(&serde_json::Value::Null);

        let path_str = model_cfg.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path_str.is_empty() {
            return Err(crate::core::errors::ApiError::BadRequest(format!(
                "Missing path for {}",
                role_key
            )));
        }

        Ok(Self {
            model_key: role_key.to_string(),
            model_path: PathBuf::from(path_str),
            port: model_cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
            n_ctx: model_cfg
                .get("n_ctx")
                .and_then(|v| v.as_u64())
                .unwrap_or(2048) as usize,
            n_gpu_layers: model_cfg
                .get("n_gpu_layers")
                .and_then(|v| v.as_i64())
                .unwrap_or(-1) as i32,
            predict_len: model_cfg
                .get("predict_len")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize),
            temperature: model_cfg
                .get("temperature")
                .and_then(|v| v.as_f64())
                .map(|v| v as f32),
            top_p: model_cfg
                .get("top_p")
                .and_then(|v| v.as_f64())
                .map(|v| v as f32),
            top_k: model_cfg
                .get("top_k")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32),
            repeat_penalty: model_cfg
                .get("repeat_penalty")
                .and_then(|v| v.as_f64())
                .map(|v| v as f32),
        })
    }
}
