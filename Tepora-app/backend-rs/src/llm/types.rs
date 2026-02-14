use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub repeat_penalty: Option<f64>,
    pub max_tokens: Option<i32>,
    pub stop: Option<Vec<String>>,
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
        }
    }

    pub fn with_config(mut self, config: &serde_json::Value) -> Self {
        // Try to find model config in standard locations
        let model_cfg = config
            .get("models_gguf")
            .and_then(|v| v.get("text_model").or_else(|| v.get("character_model")));

        if let Some(cfg) = model_cfg {
            self.temperature = cfg.get("temperature").and_then(|v| v.as_f64()).or(self.temperature);
            self.top_p = cfg.get("top_p").and_then(|v| v.as_f64()).or(self.top_p);
            self.top_k = cfg.get("top_k").and_then(|v| v.as_i64()).or(self.top_k);
            self.repeat_penalty = cfg.get("repeat_penalty").and_then(|v| v.as_f64()).or(self.repeat_penalty);
            self.max_tokens = cfg.get("max_tokens").and_then(|v| v.as_i64()).map(|v| v as i32).or(self.max_tokens);
        }
        
        self
    }
}
