use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
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
        }
    }

    pub fn with_config(mut self, config: &serde_json::Value) -> Self {
        // Try to find model config in standard locations
        let model_cfg = config
            .get("models_gguf")
            .and_then(|v| v.get("text_model").or_else(|| v.get("character_model")));

        if let Some(cfg) = model_cfg {
            self.temperature = cfg
                .get("temperature")
                .and_then(|v| v.as_f64())
                .or(self.temperature);
            self.top_p = cfg.get("top_p").and_then(|v| v.as_f64()).or(self.top_p);
            self.top_k = cfg.get("top_k").and_then(|v| v.as_i64()).or(self.top_k);
            self.repeat_penalty = cfg
                .get("repeat_penalty")
                .and_then(|v| v.as_f64())
                .or(self.repeat_penalty);
            self.max_tokens = cfg
                .get("max_tokens")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32)
                .or(self.max_tokens);
            // Read stop tokens from config if not already set
            if self.stop.is_none() {
                if let Some(stops) = cfg.get("stop").and_then(|v| v.as_array()) {
                    let tokens: Vec<String> = stops
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                    if !tokens.is_empty() {
                        self.stop = Some(tokens);
                    }
                }
            }
            // Common parameters
            self.seed = cfg.get("seed").and_then(|v| v.as_i64()).or(self.seed);
            self.frequency_penalty = cfg
                .get("frequency_penalty")
                .and_then(|v| v.as_f64())
                .or(self.frequency_penalty);
            self.presence_penalty = cfg
                .get("presence_penalty")
                .and_then(|v| v.as_f64())
                .or(self.presence_penalty);
            self.min_p = cfg.get("min_p").and_then(|v| v.as_f64()).or(self.min_p);
            // Shared llama.cpp/Ollama parameters
            self.tfs_z = cfg.get("tfs_z").and_then(|v| v.as_f64()).or(self.tfs_z);
            self.typical_p = cfg
                .get("typical_p")
                .and_then(|v| v.as_f64())
                .or(self.typical_p);
            self.mirostat = cfg
                .get("mirostat")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32)
                .or(self.mirostat);
            self.mirostat_tau = cfg
                .get("mirostat_tau")
                .and_then(|v| v.as_f64())
                .or(self.mirostat_tau);
            self.mirostat_eta = cfg
                .get("mirostat_eta")
                .and_then(|v| v.as_f64())
                .or(self.mirostat_eta);
            self.repeat_last_n = cfg
                .get("repeat_last_n")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32)
                .or(self.repeat_last_n);
            self.penalize_nl = cfg
                .get("penalize_nl")
                .and_then(|v| v.as_bool())
                .or(self.penalize_nl);
            // llama.cpp specific
            self.n_keep = cfg
                .get("n_keep")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32)
                .or(self.n_keep);
            self.cache_prompt = cfg
                .get("cache_prompt")
                .and_then(|v| v.as_bool())
                .or(self.cache_prompt);
            // Ollama specific
            self.num_ctx = cfg
                .get("num_ctx")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32)
                .or(self.num_ctx);
        }

        self
    }
}
