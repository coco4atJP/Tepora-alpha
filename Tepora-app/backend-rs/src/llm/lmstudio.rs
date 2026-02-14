use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use futures_util::StreamExt;

use crate::core::errors::ApiError;
use super::provider::LlmProvider;
use super::types::{ChatRequest, ProviderModel};

#[derive(Clone)]
pub struct LmStudioProvider {
    base_url: String,
    client: Client,
}

impl LmStudioProvider {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: Client::new(),
        }
    }
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModelInfo>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenAiModelInfo {
    id: String,
}

#[async_trait]
impl LlmProvider for LmStudioProvider {
    fn name(&self) -> &str {
        "lmstudio"
    }

    async fn health_check(&self) -> Result<bool, ApiError> {
        let url = format!("{}/v1/models", self.base_url);
        let res = self.client.get(&url).send().await;
        match res {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    async fn list_models(&self) -> Result<Vec<ProviderModel>, ApiError> {
        let url = format!("{}/v1/models", self.base_url);
        let res = self.client.get(&url).send().await.map_err(ApiError::internal)?;
        
        if !res.status().is_success() {
            return Err(ApiError::Internal(format!("Failed to list models: {}", res.status())));
        }

        let response: OpenAiModelsResponse = res.json().await.map_err(ApiError::internal)?;
        
        let models = response.data.into_iter().map(|m| {
            // LM Studio doesn't provide context length in standard list
            let context_len = 4096; 
            ProviderModel {
                id: m.id.clone(),
                name: m.id,
                ctx: context_len,
            }
        }).collect();

        Ok(models)
    }

    async fn chat(&self, request: ChatRequest, model_id: &str) -> Result<String, ApiError> {
        let url = format!("{}/v1/chat/completions", self.base_url);
        
        let mut body = json!({
            "model": model_id,
            "messages": request.messages,
            "stream": false,
        });

        if let Some(obj) = body.as_object_mut() {
            if let Some(t) = request.temperature { obj.insert("temperature".to_string(), json!(t)); }
            if let Some(t) = request.top_p { obj.insert("top_p".to_string(), json!(t)); }
            if let Some(t) = request.max_tokens { obj.insert("max_tokens".to_string(), json!(t)); }
            if let Some(s) = request.stop { obj.insert("stop".to_string(), json!(s)); }
        }

        let res = self.client.post(&url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?;

        if !res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!("LM Studio chat error: {}", text)));
        }

        let payload: Value = res.json().await.map_err(ApiError::internal)?;
        
        let content = payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();

        Ok(content)
    }

    async fn stream_chat(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let url = format!("{}/v1/chat/completions", self.base_url);
        
        let mut body = json!({
            "model": model_id,
            "messages": request.messages,
            "stream": true,
        });
        
        if let Some(obj) = body.as_object_mut() {
            if let Some(t) = request.temperature { obj.insert("temperature".to_string(), json!(t)); }
            if let Some(t) = request.top_p { obj.insert("top_p".to_string(), json!(t)); }
            if let Some(t) = request.max_tokens { obj.insert("max_tokens".to_string(), json!(t)); }
            if let Some(s) = request.stop { obj.insert("stop".to_string(), json!(s)); }
        }

        let res = self.client.post(&url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?;

        if !res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!("LM Studio stream error: {}", text)));
        }

        let (tx, rx) = mpsc::channel(32);
        let mut stream = res.bytes_stream();

        tokio::spawn(async move {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(bytes) => {
                        let chunk_str = String::from_utf8_lossy(&bytes);
                        for line in chunk_str.lines() {
                            let line = line.trim();
                            if line.is_empty() { continue; }
                            if line == "data: [DONE]" { return; }
                            
                            if let Some(data) = line.strip_prefix("data: ") {
                                if let Ok(json) = serde_json::from_str::<Value>(data) {
                                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                        if !content.is_empty()
                                            && tx.send(Ok(content.to_string())).await.is_err() {
                                                return;
                                            }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(ApiError::internal(e))).await;
                        return;
                    }
                }
            }
        });

        Ok(rx)
    }

    async fn embed(&self, inputs: &[String], model_id: &str) -> Result<Vec<Vec<f32>>, ApiError> {
        let url = format!("{}/v1/embeddings", self.base_url);
        
        let body = json!({
            "model": model_id,
            "input": inputs,
        });

        let res = self.client.post(&url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?;

        if !res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!("LM Studio embed error: {}", text)));
        }

        let payload: Value = res.json().await.map_err(ApiError::internal)?;
        
        let mut embeddings = Vec::new();
        if let Some(data) = payload["data"].as_array() {
            for item in data {
                if let Some(vals) = item["embedding"].as_array() {
                    let vec: Vec<f32> = vals.iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect();
                    embeddings.push(vec);
                }
            }
        }

        Ok(embeddings)
    }
}
