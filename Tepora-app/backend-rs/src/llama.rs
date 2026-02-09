use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::time::sleep;

use crate::config::AppPaths;
use crate::errors::ApiError;

const DEFAULT_N_CTX: i32 = 8192;
const DEFAULT_N_GPU_LAYERS: i32 = -1;
const HEALTH_TIMEOUT_SECS: u64 = 20;
const HEALTH_RETRY_SECS: u64 = 1;

#[derive(Debug, Clone, Copy)]
enum ModelRole {
    Text,
    Embedding,
}

#[derive(Debug, Clone)]
pub struct ModelRuntimeConfig {
    pub model_key: String,
    pub model_path: PathBuf,
    pub port: u16,
    pub n_ctx: i32,
    pub n_gpu_layers: i32,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub repeat_penalty: Option<f64>,
    pub logprobs: Option<bool>,
    pub enable_embedding: bool,
}

impl ModelRuntimeConfig {
    pub fn for_chat(config: &Value) -> Result<Self, ApiError> {
        Self::from_role(config, ModelRole::Text)
    }

    pub fn for_embedding(config: &Value) -> Result<Self, ApiError> {
        Self::from_role(config, ModelRole::Embedding)
    }

    fn from_role(config: &Value, role: ModelRole) -> Result<Self, ApiError> {
        let models = config
            .get("models_gguf")
            .and_then(|v| v.as_object())
            .ok_or_else(|| ApiError::BadRequest("models_gguf not found in config".to_string()))?;

        let (model_key, model_cfg) = match role {
            ModelRole::Text => (
                "text_model",
                models
                    .get("text_model")
                    .or_else(|| models.get("character_model"))
                    .ok_or_else(|| ApiError::BadRequest("text_model not configured".to_string()))?,
            ),
            ModelRole::Embedding => (
                "embedding_model",
                models.get("embedding_model").ok_or_else(|| {
                    ApiError::BadRequest("embedding_model not configured".to_string())
                })?,
            ),
        };

        let model_path = model_cfg
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ApiError::BadRequest("Model path missing".to_string()))?;

        let port = model_cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;

        let n_ctx = model_cfg
            .get("n_ctx")
            .and_then(|v| v.as_i64())
            .unwrap_or(DEFAULT_N_CTX as i64) as i32;

        let n_gpu_layers = model_cfg
            .get("n_gpu_layers")
            .and_then(|v| v.as_i64())
            .unwrap_or(DEFAULT_N_GPU_LAYERS as i64) as i32;

        let temperature = model_cfg.get("temperature").and_then(|v| v.as_f64());
        let top_p = model_cfg.get("top_p").and_then(|v| v.as_f64());
        let top_k = model_cfg.get("top_k").and_then(|v| v.as_i64());
        let repeat_penalty = model_cfg.get("repeat_penalty").and_then(|v| v.as_f64());
        let logprobs = model_cfg.get("logprobs").and_then(|v| v.as_bool());

        Ok(ModelRuntimeConfig {
            model_key: model_key.to_string(),
            model_path: PathBuf::from(model_path),
            port,
            n_ctx,
            n_gpu_layers,
            temperature,
            top_p,
            top_k,
            repeat_penalty,
            logprobs,
            enable_embedding: matches!(role, ModelRole::Embedding),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone)]
pub struct LlamaService {
    inner: std::sync::Arc<Mutex<LlamaManager>>,
    client: Client,
}

struct LlamaManager {
    binary_path: Option<PathBuf>,
    logs_dir: PathBuf,
    processes: HashMap<String, Child>,
    ports: HashMap<String, u16>,
}

impl LlamaService {
    pub fn new(paths: std::sync::Arc<AppPaths>) -> Result<Self, ApiError> {
        let binary_path = resolve_llama_binary(&paths);
        if binary_path.is_none() {
            tracing::warn!(
                "llama-server binary not found. Chat requests will fail until installed."
            );
        }

        let logs_dir = paths.log_dir.clone();
        let _ = fs::create_dir_all(&logs_dir);

        Ok(LlamaService {
            inner: std::sync::Arc::new(Mutex::new(LlamaManager {
                binary_path,
                logs_dir,
                processes: HashMap::new(),
                ports: HashMap::new(),
            })),
            client: Client::new(),
        })
    }

    pub async fn refresh_binary_path(&self, paths: &AppPaths) -> Option<PathBuf> {
        let resolved = resolve_llama_binary(paths);
        let mut guard = self.inner.lock().await;
        guard.binary_path = resolved.clone();
        resolved
    }

    pub async fn chat(
        &self,
        config: &Value,
        messages: Vec<ChatMessage>,
    ) -> Result<String, ApiError> {
        let model_cfg = ModelRuntimeConfig::for_chat(config)?;
        let port = self.ensure_running(&model_cfg).await?;
        let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);

        let mut body = Map::new();
        body.insert(
            "model".to_string(),
            Value::String(model_cfg.model_key.clone()),
        );
        body.insert(
            "messages".to_string(),
            serde_json::to_value(messages).map_err(ApiError::internal)?,
        );
        body.insert("stream".to_string(), Value::Bool(false));

        if let Some(temp) = model_cfg.temperature {
            if let Some(num) = serde_json::Number::from_f64(temp) {
                body.insert("temperature".to_string(), Value::Number(num));
            }
        }
        if let Some(top_p) = model_cfg.top_p {
            if let Some(num) = serde_json::Number::from_f64(top_p) {
                body.insert("top_p".to_string(), Value::Number(num));
            }
        }
        if let Some(top_k) = model_cfg.top_k {
            body.insert("top_k".to_string(), Value::Number(top_k.into()));
        }
        if let Some(repeat_penalty) = model_cfg.repeat_penalty {
            if let Some(num) = serde_json::Number::from_f64(repeat_penalty) {
                body.insert("repeat_penalty".to_string(), Value::Number(num));
            }
        }
        if let Some(logprobs) = model_cfg.logprobs {
            body.insert("logprobs".to_string(), Value::Bool(logprobs));
        }

        let response = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "LLM request failed: {} {}",
                status, text
            )));
        }

        let payload: Value = response.json().await.map_err(ApiError::internal)?;
        let content = payload
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|msg| msg.get("content"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                payload
                    .get("choices")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|choice| choice.get("text"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();

        Ok(content)
    }

    pub async fn stream_chat(
        &self,
        config: &Value,
        messages: Vec<ChatMessage>,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let model_cfg = ModelRuntimeConfig::for_chat(config)?;
        let port = self.ensure_running(&model_cfg).await?;
        let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);

        let mut body = Map::new();
        body.insert(
            "model".to_string(),
            Value::String(model_cfg.model_key.clone()),
        );
        body.insert(
            "messages".to_string(),
            serde_json::to_value(messages).map_err(ApiError::internal)?,
        );
        body.insert("stream".to_string(), Value::Bool(true));

        if let Some(temp) = model_cfg.temperature {
            if let Some(num) = serde_json::Number::from_f64(temp) {
                body.insert("temperature".to_string(), Value::Number(num));
            }
        }
        if let Some(top_p) = model_cfg.top_p {
            if let Some(num) = serde_json::Number::from_f64(top_p) {
                body.insert("top_p".to_string(), Value::Number(num));
            }
        }
        if let Some(top_k) = model_cfg.top_k {
            body.insert("top_k".to_string(), Value::Number(top_k.into()));
        }
        if let Some(repeat_penalty) = model_cfg.repeat_penalty {
            if let Some(num) = serde_json::Number::from_f64(repeat_penalty) {
                body.insert("repeat_penalty".to_string(), Value::Number(num));
            }
        }
        if let Some(logprobs) = model_cfg.logprobs {
            body.insert("logprobs".to_string(), Value::Bool(logprobs));
        }

        let client = self.client.clone();
        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            let response = match client.post(url).json(&body).send().await {
                Ok(resp) => resp,
                Err(err) => {
                    let _ = tx.send(Err(ApiError::internal(err))).await;
                    return;
                }
            };

            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                let _ = tx
                    .send(Err(ApiError::Internal(format!(
                        "LLM request failed: {} {}",
                        status, text
                    ))))
                    .await;
                return;
            }

            let mut stream = response.bytes_stream();
            let mut buffer = String::new();

            while let Some(item) = stream.next().await {
                match item {
                    Ok(bytes) => {
                        let chunk = String::from_utf8_lossy(&bytes);
                        buffer.push_str(&chunk);

                        while let Some(pos) = buffer.find('\n') {
                            let mut line = buffer[..pos].to_string();
                            buffer = buffer[pos + 1..].to_string();
                            line = line.trim().to_string();
                            if line.is_empty() {
                                continue;
                            }
                            if let Some(payload) = line.strip_prefix("data:") {
                                let data = payload.trim();
                                if data == "[DONE]" {
                                    return;
                                }
                                if let Ok(json_value) = serde_json::from_str::<Value>(data) {
                                    if let Some(delta) = extract_delta(&json_value) {
                                        if !delta.is_empty() {
                                            let _ = tx.send(Ok(delta)).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(Err(ApiError::internal(err))).await;
                        return;
                    }
                }
            }
        });

        Ok(rx)
    }

    pub async fn embed(
        &self,
        config: &Value,
        inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        let model_cfg = ModelRuntimeConfig::for_embedding(config)?;
        let port = self.ensure_running(&model_cfg).await?;
        let url = format!("http://127.0.0.1:{}/v1/embeddings", port);

        let body = serde_json::json!({
            "model": model_cfg.model_key,
            "input": inputs,
        });

        let response = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "Embedding request failed: {} {}",
                status, text
            )));
        }

        let payload: Value = response.json().await.map_err(ApiError::internal)?;
        parse_embedding_response(&payload)
    }

    async fn ensure_running(&self, config: &ModelRuntimeConfig) -> Result<u16, ApiError> {
        if !config.model_path.exists() {
            return Err(ApiError::BadRequest(format!(
                "Model file not found: {}",
                config.model_path.display()
            )));
        }

        let mut guard = self.inner.lock().await;
        let binary_path = guard
            .binary_path
            .clone()
            .ok_or(ApiError::ServiceUnavailable)?;
        if let Some(port) = guard.get_running_port(&config.model_key) {
            return Ok(port);
        }

        let port = if config.port > 0 {
            config.port
        } else {
            find_free_port()?
        };
        let log_path = guard.build_log_path(&config.model_key)?;

        let mut command = Command::new(&binary_path);
        command
            .arg("-m")
            .arg(&config.model_path)
            .arg("--port")
            .arg(port.to_string())
            .arg("-c")
            .arg(config.n_ctx.to_string())
            .arg("--n-gpu-layers")
            .arg(config.n_gpu_layers.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_path));

        if config.enable_embedding {
            command.arg("--embedding");
        }

        let child = command.spawn().map_err(ApiError::internal)?;
        guard.processes.insert(config.model_key.clone(), child);
        guard.ports.insert(config.model_key.clone(), port);
        drop(guard);

        if let Err(err) = self.perform_health_check(port).await {
            self.terminate_model(&config.model_key).await;
            return Err(err);
        }
        Ok(port)
    }

    async fn terminate_model(&self, model_key: &str) {
        let mut guard = self.inner.lock().await;
        if let Some(mut child) = guard.processes.remove(model_key) {
            let _ = child.kill();
            let _ = child.wait();
        }
        guard.ports.remove(model_key);
    }

    async fn perform_health_check(&self, port: u16) -> Result<(), ApiError> {
        let url = format!("http://127.0.0.1:{}/health", port);
        let retries = (HEALTH_TIMEOUT_SECS / HEALTH_RETRY_SECS).max(1);

        for _ in 0..retries {
            if let Ok(response) = self.client.get(&url).send().await {
                if response.status().is_success() {
                    if let Ok(payload) = response.json::<Value>().await {
                        if payload.get("status").and_then(|v| v.as_str()) == Some("ok") {
                            return Ok(());
                        }
                    }
                }
            }
            sleep(Duration::from_secs(HEALTH_RETRY_SECS)).await;
        }

        Err(ApiError::Internal(
            "LLM server failed health check".to_string(),
        ))
    }
}

impl LlamaManager {
    fn get_running_port(&mut self, model_key: &str) -> Option<u16> {
        if let Some(child) = self.processes.get_mut(model_key) {
            if child.try_wait().ok().flatten().is_none() {
                return self.ports.get(model_key).copied();
            }
            self.processes.remove(model_key);
            self.ports.remove(model_key);
        }
        None
    }

    fn build_log_path(&self, model_key: &str) -> Result<fs::File, ApiError> {
        let safe = model_key
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let filename = format!(
            "llama_server_{}_{}.log",
            safe,
            chrono::Utc::now().timestamp()
        );
        let path = self.logs_dir.join(filename);
        fs::File::create(&path).map_err(ApiError::internal)
    }
}

fn resolve_llama_binary(paths: &AppPaths) -> Option<PathBuf> {
    for key in ["TEPORA_LLAMA_SERVER", "LLAMA_SERVER_PATH", "LLAMA_SERVER"] {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from(value);
            if path.exists() {
                return Some(path);
            }
        }
    }

    let candidates = [
        paths.user_data_dir.join("bin").join("llama.cpp"),
        paths.project_root.join("bin").join("llama.cpp"),
        paths
            .project_root
            .parent()
            .unwrap_or(&paths.project_root)
            .join("frontend")
            .join("src-tauri")
            .join("resources"),
        paths
            .project_root
            .parent()
            .unwrap_or(&paths.project_root)
            .join("frontend")
            .join("src-tauri")
            .join("binaries"),
    ];

    for root in candidates {
        if let Some(found) = find_server_executable(&root) {
            return Some(found);
        }
    }

    None
}

fn find_server_executable(root: &Path) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };

    if !root.exists() {
        return None;
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().and_then(|n| n.to_str()) == Some(exe_name) {
                return Some(path);
            }
        }
    }

    None
}

fn find_free_port() -> Result<u16, ApiError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(ApiError::internal)?;
    let port = listener.local_addr().map_err(ApiError::internal)?.port();
    Ok(port)
}

fn parse_embedding_response(payload: &Value) -> Result<Vec<Vec<f32>>, ApiError> {
    let Some(data) = payload.get("data").and_then(|v| v.as_array()) else {
        return Err(ApiError::Internal(
            "Embedding response missing data array".to_string(),
        ));
    };

    let mut indexed_embeddings = Vec::with_capacity(data.len());
    for (fallback_idx, item) in data.iter().enumerate() {
        let Some(values) = item.get("embedding").and_then(|v| v.as_array()) else {
            return Err(ApiError::Internal(
                "Embedding response item missing embedding array".to_string(),
            ));
        };

        let mut embedding = Vec::with_capacity(values.len());
        for value in values {
            let Some(float_value) = value.as_f64() else {
                return Err(ApiError::Internal(
                    "Embedding contains non-numeric value".to_string(),
                ));
            };
            embedding.push(float_value as f32);
        }

        let index = item
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(fallback_idx);
        indexed_embeddings.push((index, embedding));
    }

    indexed_embeddings.sort_by_key(|(idx, _)| *idx);
    Ok(indexed_embeddings
        .into_iter()
        .map(|(_, embedding)| embedding)
        .collect())
}

fn extract_delta(payload: &Value) -> Option<String> {
    let choice = payload
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());
    let delta = choice.and_then(|c| c.get("delta"));
    if let Some(content) = delta
        .and_then(|d| d.get("content"))
        .and_then(|v| v.as_str())
    {
        return Some(content.to_string());
    }
    if let Some(content) = choice
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
    {
        return Some(content.to_string());
    }
    if let Some(text) = choice.and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_embedding_response;

    #[test]
    fn parse_embedding_response_preserves_input_order_by_index() {
        let payload = json!({
            "data": [
                {"index": 1, "embedding": [0.3, 0.4]},
                {"index": 0, "embedding": [0.1, 0.2]}
            ]
        });

        let parsed = parse_embedding_response(&payload).expect("embedding payload should parse");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], vec![0.1_f32, 0.2_f32]);
        assert_eq!(parsed[1], vec![0.3_f32, 0.4_f32]);
    }
}
