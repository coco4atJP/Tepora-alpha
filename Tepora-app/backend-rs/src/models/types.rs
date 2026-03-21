use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Ollama API types
// ---------------------------------------------------------------------------

/// GET /api/tags レスポンス
#[derive(Debug, Deserialize)]
pub struct OllamaTagsResponse {
    pub models: Vec<OllamaModel>,
}

/// GET /api/tags の models[*].details
#[derive(Debug, Deserialize, Default)]
pub struct OllamaModelDetails {
    pub family: Option<String>,
    pub families: Option<Vec<String>>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
    pub format: Option<String>,
}

/// GET /api/tags の models[*]
#[derive(Debug, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub digest: String,
    #[serde(default)]
    pub details: OllamaModelDetails,
}

/// POST /api/show レスポンス
#[derive(Debug, Deserialize, Default)]
pub struct OllamaShowResponse {
    /// Go template 形式のチャットテンプレート
    pub template: Option<String>,
    /// "stop \"<|eot_id|>\"\ntemperature 0.2\n..." 形式の生テキスト
    pub parameters: Option<String>,
    /// ["completion", "tools"] 等
    pub capabilities: Option<Vec<String>>,
    /// GGUF メタデータの生 JSON オブジェクト
    pub model_info: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub details: OllamaModelDetails,
}
// ---------------------------------------------------------------------------
// LM Studio API types
// ---------------------------------------------------------------------------

/// GET /api/v1/models レスポンス（LM Studio 独自エンドポイント）
#[derive(Debug, Deserialize)]
pub struct LmStudioV1Response {
    pub models: Vec<LmStudioV1Model>,
}

/// GET /api/v1/models の models[*]
#[derive(Debug, Deserialize)]
pub struct LmStudioV1Model {
    #[serde(rename = "type")]
    pub model_type: String, // "llm" | "vlm" | "embedding"
    pub publisher: Option<String>,
    pub key: String,
    pub display_name: Option<String>,
    pub architecture: Option<String>,
    pub quantization: Option<LmStudioQuantization>,
    pub size_bytes: Option<u64>,
    pub params_string: Option<String>,
    pub max_context_length: Option<u64>,
    pub format: Option<String>, // "gguf" | "mlx" | null
    pub capabilities: Option<LmStudioCapabilities>,
    pub description: Option<String>,
}

/// LM Studio の quantization オブジェクト
#[derive(Debug, Deserialize)]
pub struct LmStudioQuantization {
    pub name: Option<String>,
}

/// LM Studio の capabilities オブジェクト
#[derive(Debug, Deserialize)]
pub struct LmStudioCapabilities {
    pub vision: bool,
    pub trained_for_tool_use: bool,
}

// ---------------------------------------------------------------------------
// Core registry types
// ---------------------------------------------------------------------------

/// モデルの機能フラグ（ローダー横断で統一された形式）
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ModelCapabilities {
    /// テキスト生成（Completion）サポート
    #[serde(default)]
    pub completion: bool,
    /// Function Calling / Tool Use サポート
    #[serde(default)]
    pub tool_use: bool,
    /// 画像入力（Vision）サポート
    #[serde(default)]
    pub vision: bool,
}

/// モデルレジストリの個別エントリ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    // --- 基本 ID ---
    pub id: String,
    pub display_name: String,
    /// モデルの役割: "text" | "embedding"
    pub role: String,

    // --- ストレージ情報 ---
    pub file_size: u64,
    pub filename: String,
    /// 取得元: "local" | "ollama" | "lmstudio" | HuggingFace repo_id
    pub source: String,
    /// ローカルパス or ローダー URI ("ollama://...", "lmstudio://...")
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

    // --- スペック情報 ---
    #[serde(default)]
    pub parameter_size: Option<String>, // "8.3B", "20.9B" 等
    #[serde(default)]
    pub quantization: Option<String>, // "Q4_K_M", "BF16" 等
    #[serde(default)]
    pub context_length: Option<u64>, // トークン数
    #[serde(default)]
    pub architecture: Option<String>, // "gemma3", "llama", "mistral3" 等

    // --- インターフェース情報 ---
    #[serde(default)]
    pub chat_template: Option<String>, // Go template / jinja2 形式
    #[serde(default)]
    pub stop_tokens: Option<Vec<String>>, // ["<|eot_id|>", ...] 等
    #[serde(default)]
    pub default_temperature: Option<f32>, // Ollama Modelfile のデフォルト値

    // --- 機能情報 ---
    #[serde(default)]
    pub capabilities: Option<ModelCapabilities>,

    // --- メタデータ ---
    #[serde(default)]
    pub publisher: Option<String>, // "ibm", "mistralai" 等
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub format: Option<String>, // "gguf", "mlx" 等
    #[serde(default)]
    pub tokenizer_path: Option<String>,
    #[serde(default)]
    pub tokenizer_format: Option<String>,
}

/// モデルレジストリ（models.json ルート）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelRegistry {
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    /// role -> model_id のマッピング（アクティブモデル）
    #[serde(default)]
    pub role_assignments: HashMap<String, String>,
    /// role -> [model_id, ...] の表示順
    #[serde(default)]
    pub role_order: HashMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Download types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Runtime config types
// ---------------------------------------------------------------------------

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
    pub stop: Option<Vec<String>>,
    // --- Common new ---
    pub seed: Option<i64>,
    pub frequency_penalty: Option<f32>,
    pub presence_penalty: Option<f32>,
    pub min_p: Option<f32>,
    // --- llama.cpp specific ---
    pub tfs_z: Option<f32>,
    pub typical_p: Option<f32>,
    pub mirostat: Option<i32>,
    pub mirostat_tau: Option<f32>,
    pub mirostat_eta: Option<f32>,
    pub repeat_last_n: Option<i32>,
    pub penalize_nl: Option<bool>,
    pub n_keep: Option<i32>,
    pub cache_prompt: Option<bool>,
}

impl ModelRuntimeConfig {
    #[allow(dead_code)]
    pub fn for_chat(config: &serde_json::Value) -> Result<Self, crate::core::errors::ApiError> {
        Self::from_config(config, "text")
    }

    pub fn for_embedding(
        config: &serde_json::Value,
    ) -> Result<Self, crate::core::errors::ApiError> {
        Self::from_config(config, "embedding")
    }

    fn from_config(
        config: &serde_json::Value,
        role_key: &str,
    ) -> Result<Self, crate::core::errors::ApiError> {
        let models = config.get("models").or_else(|| config.get("models_gguf")).and_then(|v| v.as_object());
        let model_cfg = models
            .and_then(|m| {
                m.get(role_key).or_else(|| {
                    if role_key == "text" {
                        m.get("text_model").or_else(|| m.get("character_model"))
                    } else if role_key == "embedding" {
                        m.get("embedding_model")
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(&serde_json::Value::Null);

        let path_str = model_cfg.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path_str.is_empty() {
            return Err(crate::core::errors::ApiError::BadRequest(format!(
                "Missing path for {}",
                role_key
            )));
        }

        let stop = model_cfg
            .get("stop")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<String>>()
            })
            .filter(|v| !v.is_empty());
        let llm_defaults = config.get("llm_defaults");
        let stop = stop.or_else(|| {
            llm_defaults
                .and_then(|defaults| defaults.get("stop"))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<String>>()
                })
                .filter(|v| !v.is_empty())
        });

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
            predict_len: read_config_usize(
                model_cfg,
                llm_defaults,
                &["predict_len", "max_tokens", "n_predict"],
            ),
            temperature: read_config_f32(model_cfg, llm_defaults, "temperature"),
            top_p: read_config_f32(model_cfg, llm_defaults, "top_p"),
            top_k: read_config_i32(model_cfg, llm_defaults, "top_k"),
            repeat_penalty: read_config_f32(model_cfg, llm_defaults, "repeat_penalty"),
            stop,
            seed: read_config_i64(model_cfg, llm_defaults, "seed"),
            frequency_penalty: read_config_f32(model_cfg, llm_defaults, "frequency_penalty"),
            presence_penalty: read_config_f32(model_cfg, llm_defaults, "presence_penalty"),
            min_p: read_config_f32(model_cfg, llm_defaults, "min_p"),
            tfs_z: read_config_f32(model_cfg, llm_defaults, "tfs_z"),
            typical_p: read_config_f32(model_cfg, llm_defaults, "typical_p"),
            mirostat: read_config_i32(model_cfg, llm_defaults, "mirostat"),
            mirostat_tau: read_config_f32(model_cfg, llm_defaults, "mirostat_tau"),
            mirostat_eta: read_config_f32(model_cfg, llm_defaults, "mirostat_eta"),
            repeat_last_n: read_config_i32(model_cfg, llm_defaults, "repeat_last_n"),
            penalize_nl: read_config_bool(model_cfg, llm_defaults, "penalize_nl"),
            n_keep: read_config_i32(model_cfg, llm_defaults, "n_keep"),
            cache_prompt: read_config_bool(model_cfg, llm_defaults, "cache_prompt"),
        })
    }
}

fn read_config_i64(
    model_cfg: &serde_json::Value,
    defaults: Option<&serde_json::Value>,
    key: &str,
) -> Option<i64> {
    model_cfg
        .get(key)
        .and_then(|v| v.as_i64())
        .or_else(|| defaults.and_then(|v| v.get(key)).and_then(|v| v.as_i64()))
}

fn read_config_i32(
    model_cfg: &serde_json::Value,
    defaults: Option<&serde_json::Value>,
    key: &str,
) -> Option<i32> {
    read_config_i64(model_cfg, defaults, key).map(|v| v as i32)
}

fn read_config_usize(
    model_cfg: &serde_json::Value,
    defaults: Option<&serde_json::Value>,
    keys: &[&str],
) -> Option<usize> {
    keys.iter().find_map(|key| {
        model_cfg
            .get(*key)
            .and_then(|v| v.as_u64())
            .or_else(|| defaults.and_then(|v| v.get(*key)).and_then(|v| v.as_u64()))
            .map(|v| v as usize)
    })
}

fn read_config_f32(
    model_cfg: &serde_json::Value,
    defaults: Option<&serde_json::Value>,
    key: &str,
) -> Option<f32> {
    model_cfg
        .get(key)
        .and_then(|v| v.as_f64())
        .or_else(|| defaults.and_then(|v| v.get(key)).and_then(|v| v.as_f64()))
        .map(|v| v as f32)
}

fn read_config_bool(
    model_cfg: &serde_json::Value,
    defaults: Option<&serde_json::Value>,
    key: &str,
) -> Option<bool> {
    model_cfg
        .get(key)
        .and_then(|v| v.as_bool())
        .or_else(|| defaults.and_then(|v| v.get(key)).and_then(|v| v.as_bool()))
}
