use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 画像データ（Base64エンコード済み）
#[derive(Debug, Clone)]
pub struct ImageData {
    pub mime_type: String,
    pub base64: String,
}

impl ImageData {
    /// `data:<mime_type>;base64,<data>` 形式のData URIを生成する
    pub fn to_data_uri(&self) -> String {
        format!("data:{};base64,{}", self.mime_type, self.base64)
    }
}

/// LLMへ送信するチャットメッセージ。
///
/// テキストのみの場合は `content` にテキストを設定し `multimodal_parts` を None のままにする。
/// 画像を含む場合は `multimodal_parts` に OpenAI 互換の parts 配列を設定する:
/// ```json
/// [
///   {"type": "text", "text": "..."},
///   {"type": "image_url", "image_url": {"url": "data:image/...;base64,..."}}
/// ]
/// ```
/// `content` には既存コードの互換性のためテキスト部分が格納される。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// 画像等のマルチモーダルコンテンツが存在する場合に設定する（OpenAI互換形式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal_parts: Option<Vec<Value>>,
}

impl ChatMessage {
    /// テキストのみのメッセージを作成する（既存コードとの互換性維持）
    pub fn new_text(role: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: text.into(),
            multimodal_parts: None,
        }
    }

    /// テキスト + 画像のマルチモーダルメッセージを作成する（OpenAI互換形式）
    pub fn new_multimodal(role: impl Into<String>, text: &str, images: &[ImageData]) -> Self {
        let mut parts: Vec<Value> = vec![json!({"type": "text", "text": text})];
        for img in images {
            parts.push(json!({
                "type": "image_url",
                "image_url": {"url": img.to_data_uri()}
            }));
        }
        Self {
            role: role.into(),
            content: text.to_string(),
            multimodal_parts: Some(parts),
        }
    }

    /// テキスト部分を取得する（`content` と同じ）
    pub fn text_content(&self) -> &str {
        &self.content
    }

    /// 画像データの一覧を取得する（例: Ollama の `images` フィールド構築用）
    pub fn image_data_list(&self) -> Vec<ImageData> {
        let Some(parts) = &self.multimodal_parts else {
            return Vec::new();
        };
        parts
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(|t| t.as_str()) != Some("image_url") {
                    return None;
                }
                let url = part
                    .get("image_url")
                    .and_then(|obj| obj.get("url"))
                    .and_then(|u| u.as_str())?;
                // "data:<mime_type>;base64,<data>" をパース
                let rest = url.strip_prefix("data:")?;
                let (mime_part, b64_part) = rest.split_once(";base64,")?;
                Some(ImageData {
                    mime_type: mime_part.to_string(),
                    base64: b64_part.to_string(),
                })
            })
            .collect()
    }

    /// 画像を含むかどうかを判定する
    pub fn has_images(&self) -> bool {
        self.multimodal_parts
            .as_ref()
            .map(|parts| {
                parts
                    .iter()
                    .any(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
            })
            .unwrap_or(false)
    }

    /// LLMへ送信するための `content` JSON値を取得する。
    /// 画像があれば parts 配列を、なければ文字列を返す。
    pub fn to_content_value(&self) -> Value {
        if let Some(parts) = &self.multimodal_parts {
            Value::Array(parts.clone())
        } else {
            Value::String(self.content.clone())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredResponseSpec {
    pub name: String,
    pub schema: serde_json::Value,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    // --- Basic sampling ---
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub repeat_penalty: Option<f64>,
    pub max_tokens: Option<i32>,
    pub stop: Option<Vec<String>>,
    // --- Common (all engines) ---
    pub seed: Option<i64>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub min_p: Option<f64>,
    // --- llama.cpp / Ollama shared ---
    pub tfs_z: Option<f64>,
    pub typical_p: Option<f64>,
    pub mirostat: Option<i32>,
    pub mirostat_tau: Option<f64>,
    pub mirostat_eta: Option<f64>,
    pub repeat_last_n: Option<i32>,
    pub penalize_nl: Option<bool>,
    // --- llama.cpp specific ---
    pub n_keep: Option<i32>,
    pub cache_prompt: Option<bool>,
    // --- Ollama specific ---
    pub num_ctx: Option<i32>,
    // --- Structured outputs ---
    pub structured_response: Option<StructuredResponseSpec>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: Option<usize>,
    pub completion_tokens: Option<usize>,
    pub total_tokens: Option<usize>,
    pub cached_prompt_tokens: Option<usize>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NormalizedAssistantTurn {
    pub visible_text: String,
    pub model_thinking: String,
    pub finish_reason: Option<String>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NormalizedStreamChunk {
    pub visible_text: String,
    pub model_thinking: String,
    pub done: bool,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ProviderModel {
    pub id: String,
    pub name: String,
    pub ctx: u64,
}

impl ChatRequest {
    pub fn new(messages: Vec<ChatMessage>) -> Self {
        Self {
            messages,
            temperature: None,
            top_p: None,
            top_k: None,
            repeat_penalty: None,
            max_tokens: None,
            stop: None,
            seed: None,
            frequency_penalty: None,
            presence_penalty: None,
            min_p: None,
            tfs_z: None,
            typical_p: None,
            mirostat: None,
            mirostat_tau: None,
            mirostat_eta: None,
            repeat_last_n: None,
            penalize_nl: None,
            n_keep: None,
            cache_prompt: None,
            num_ctx: None,
            structured_response: None,
        }
    }

    pub fn with_structured_response(mut self, spec: StructuredResponseSpec) -> Self {
        self.structured_response = Some(spec);
        self
    }

    pub fn with_config(mut self, config: &serde_json::Value) -> Self {
        if let Some(defaults) = config.get("llm_defaults") {
            self.apply_sampling_config(defaults);
        }

        // Try to find model config in standard locations
        let model_cfg = config
            .get("models_gguf")
            .and_then(|v| v.get("text_model").or_else(|| v.get("character_model")));

        if let Some(cfg) = model_cfg {
            self.apply_sampling_config(cfg);
        }

        self
    }

    fn apply_sampling_config(&mut self, config: &serde_json::Value) {
        self.temperature = config
            .get("temperature")
            .and_then(|v| v.as_f64())
            .or(self.temperature);
        self.top_p = config.get("top_p").and_then(|v| v.as_f64()).or(self.top_p);
        self.top_k = config.get("top_k").and_then(|v| v.as_i64()).or(self.top_k);
        self.repeat_penalty = config
            .get("repeat_penalty")
            .and_then(|v| v.as_f64())
            .or(self.repeat_penalty);
        self.max_tokens = config
            .get("max_tokens")
            .or_else(|| config.get("predict_len"))
            .or_else(|| config.get("n_predict"))
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .or(self.max_tokens);
        if self.stop.is_none() {
            if let Some(stops) = config.get("stop").and_then(|v| v.as_array()) {
                let tokens: Vec<String> = stops
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                if !tokens.is_empty() {
                    self.stop = Some(tokens);
                }
            }
        }
        self.seed = config.get("seed").and_then(|v| v.as_i64()).or(self.seed);
        self.frequency_penalty = config
            .get("frequency_penalty")
            .and_then(|v| v.as_f64())
            .or(self.frequency_penalty);
        self.presence_penalty = config
            .get("presence_penalty")
            .and_then(|v| v.as_f64())
            .or(self.presence_penalty);
        self.min_p = config.get("min_p").and_then(|v| v.as_f64()).or(self.min_p);
        self.tfs_z = config.get("tfs_z").and_then(|v| v.as_f64()).or(self.tfs_z);
        self.typical_p = config
            .get("typical_p")
            .and_then(|v| v.as_f64())
            .or(self.typical_p);
        self.mirostat = config
            .get("mirostat")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .or(self.mirostat);
        self.mirostat_tau = config
            .get("mirostat_tau")
            .and_then(|v| v.as_f64())
            .or(self.mirostat_tau);
        self.mirostat_eta = config
            .get("mirostat_eta")
            .and_then(|v| v.as_f64())
            .or(self.mirostat_eta);
        self.repeat_last_n = config
            .get("repeat_last_n")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .or(self.repeat_last_n);
        self.penalize_nl = config
            .get("penalize_nl")
            .and_then(|v| v.as_bool())
            .or(self.penalize_nl);
        self.n_keep = config
            .get("n_keep")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .or(self.n_keep);
        self.cache_prompt = config
            .get("cache_prompt")
            .and_then(|v| v.as_bool())
            .or(self.cache_prompt);
        self.num_ctx = config
            .get("num_ctx")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .or(self.num_ctx);
    }
}
