use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use reqwest::Client;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;
use crate::models::types::ModelRuntimeConfig;

const DEFAULT_SERVER_PORT: u16 = 8080;
const MAX_SERVER_RETRIES: u32 = 30;

#[derive(Clone)]
pub struct LlamaService {
    inner: Arc<Mutex<LlamaManager>>,
    client: Client,
}

struct LlamaManager {
    child_process: Option<Child>,
    port: u16,
    running: Arc<AtomicBool>,
    server_path: PathBuf,
    model_config: Option<ModelRuntimeConfig>,
}

impl Drop for LlamaManager {
    fn drop(&mut self) {
        if let Some(child) = self.child_process.as_mut() {
            if let Err(err) = child.start_kill() {
                tracing::debug!("Failed to kill llama-server process during drop: {}", err);
            }
        }
    }
}

use crate::llm::types::ChatMessage;

// Removed duplicate struct ChatMessage

impl LlamaService {
    pub fn new(paths: Arc<AppPaths>) -> Result<Self, ApiError> {
        let server_path = Self::find_server_binary(&paths)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(LlamaManager {
                child_process: None,
                port: DEFAULT_SERVER_PORT,
                running: Arc::new(AtomicBool::new(false)),
                server_path,
                model_config: None,
            })),
            client: Client::new(),
        })
    }

    fn find_server_binary(paths: &AppPaths) -> Result<PathBuf, ApiError> {
        let candidates = vec![
            paths.project_root.join("bin/llama-server.exe"),
            paths.project_root.join("bin/llama-server"),
            PathBuf::from("llama-server"),
        ];

        for path in candidates {
            if path.exists() || which::which(&path).is_ok() {
                return Ok(path);
            }
        }
        Ok(PathBuf::from("llama-server"))
    }

    pub async fn refresh_binary_path(&self, paths: &AppPaths) -> Result<(), ApiError> {
        let mut manager = self.inner.lock().await;
        manager.server_path = Self::find_server_binary(paths)?;
        Ok(())
    }

    pub async fn ensure_running(
        &self,
        config: &ModelRuntimeConfig,
        timeout: Duration,
    ) -> Result<(), ApiError> {
        let mut manager = self.inner.lock().await;

        if manager.running.load(Ordering::SeqCst) {
            if let Some(current) = &manager.model_config {
                if current.model_path == config.model_path {
                    return Ok(());
                }
            }
            self.stop_internal(&mut manager, timeout).await?;
        }

        self.start_internal(&mut manager, config).await?;
        Ok(())
    }

    pub async fn stop(&self, timeout: Duration) -> Result<(), ApiError> {
        let mut manager = self.inner.lock().await;
        self.stop_internal(&mut manager, timeout).await
    }

    async fn start_internal(
        &self,
        manager: &mut LlamaManager,
        config: &ModelRuntimeConfig,
    ) -> Result<(), ApiError> {
        let port = if config.port > 0 {
            config.port
        } else {
            DEFAULT_SERVER_PORT
        };

        let mut cmd = Command::new(&manager.server_path);
        cmd.arg("-m").arg(&config.model_path);
        cmd.arg("--port").arg(port.to_string());
        cmd.arg("-c").arg(config.n_ctx.to_string());

        if config.n_gpu_layers >= 0 {
            cmd.arg("-ngl").arg(config.n_gpu_layers.to_string());
        }

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| ApiError::internal(format!("Failed to spawn llama-server: {}", e)))?;

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::debug!("[llama-server] {}", line);
            }
        });
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::debug!("[llama-server-err] {}", line);
            }
        });

        manager.child_process = Some(child);
        manager.port = port;
        manager.model_config = Some(config.clone());
        manager.running.store(true, Ordering::SeqCst);

        self.wait_for_health(port).await?;

        Ok(())
    }

    async fn stop_internal(
        &self,
        manager: &mut LlamaManager,
        timeout: Duration,
    ) -> Result<(), ApiError> {
        if let Some(mut child) = manager.child_process.take() {
            if let Some(pid) = child.id() {
                tracing::info!("Stopping llama-server process (pid={})", pid);
            }

            if let Err(err) = child.start_kill() {
                tracing::warn!("Failed to signal llama-server process: {}", err);
            }

            match tokio::time::timeout(timeout, child.wait()).await {
                Ok(Ok(status)) => {
                    tracing::info!("llama-server stopped with status: {}", status);
                }
                Ok(Err(err)) => {
                    tracing::warn!(
                        "Failed to wait for llama-server process termination: {}",
                        err
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        "Timed out waiting {:?} for llama-server process termination",
                        timeout
                    );
                }
            }
        }
        manager.running.store(false, Ordering::SeqCst);
        manager.model_config = None;
        Ok(())
    }

    async fn wait_for_health(&self, port: u16) -> Result<(), ApiError> {
        let url = format!("http://localhost:{}/health", port);
        for _ in 0..MAX_SERVER_RETRIES {
            if self.client.get(&url).send().await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(ApiError::internal("Timed out waiting for llama-server"))
    }

    pub async fn get_logprobs(
        &self,
        config: &ModelRuntimeConfig,
        text: &str,
        timeout: Duration,
    ) -> Result<Vec<(String, f64)>, ApiError> {
        self.ensure_running(config, timeout).await?;

        let manager = self.inner.lock().await;
        let url = format!("http://localhost:{}/completion", manager.port);
        drop(manager);

        let body = json!({
            "prompt": text,
            "stream": false,
            "n_predict": 1,
            "n_probs": 1,
            "echo": true
        });

        let res = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?;

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().await.unwrap_or_default();
            return Err(ApiError::internal(format!(
                "Llama server logprobs error ({}): {}",
                status, err_text
            )));
        }

        let data: Value = res.json().await.map_err(ApiError::internal)?;
        let mut result = Vec::new();

        if let Some(probs) = data
            .get("completion_probabilities")
            .and_then(|v| v.as_array())
        {
            for prob in probs {
                if let Some(content) = prob.get("content").and_then(|v| v.as_str()) {
                    // Extract logprob from the 'probs' array, fallback to 0.0 if missing
                    let mut logprob_f64 = 0.0;
                    if let Some(top_probs) = prob.get("probs").and_then(|v| v.as_array()) {
                        if let Some(first) = top_probs.first() {
                            // Can be stored as logprob directly or prob depending on llama.cpp version. Wait, llama.cpp returns directly 'prob' or 'logprob'? It depends, usually it's in log space.
                            if let Some(s) = first.get("tok_str").and_then(|v| v.as_str()) {
                                if s == content {
                                    // Normally 'tok_str' matches 'content', then there's a field.
                                    // Usually "prob" contains the actual probability. We convert to log scale.
                                    if let Some(p) = first.get("prob").and_then(|v| v.as_f64()) {
                                        logprob_f64 = p.ln();
                                    }
                                }
                            }
                        }
                    }
                    result.push((content.to_string(), logprob_f64));
                }
            }
        }

        if result.is_empty() {
            return Err(ApiError::internal(
                "No valid logprobs returned by llama-server.",
            ));
        }

        // Exclude the generated token (the very last one), we only care about prompt evaluation echo.
        // n_predict=1 generates 1 extra token, which we pop off.
        if result.len() > 1 {
            result.pop();
        }

        Ok(result)
    }

    pub async fn chat(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
        timeout: Duration,
    ) -> Result<String, ApiError> {
        self.ensure_running(config, timeout).await?;

        let manager = self.inner.lock().await;
        let url = format!("http://localhost:{}/completion", manager.port);
        drop(manager);

        let prompt = self.format_chat_prompt(messages);

        let stop_tokens = config.stop.as_deref().unwrap_or(&[]);
        let default_stops: Vec<String> = vec!["User:".to_string(), "System:".to_string()];
        let stop = if stop_tokens.is_empty() {
            &default_stops
        } else {
            stop_tokens
        };

        let mut body = json!({
            "prompt": prompt,
            "stream": false,
            "n_predict": config.predict_len.unwrap_or(1024),
            "temperature": config.temperature.unwrap_or(0.7),
            "top_p": config.top_p.unwrap_or(0.9),
            "top_k": config.top_k.unwrap_or(40),
            "repeat_penalty": config.repeat_penalty.unwrap_or(1.1),
            "stop": stop
        });
        // Add optional llama.cpp parameters
        if let Some(obj) = body.as_object_mut() {
            if let Some(v) = config.seed {
                obj.insert("seed".into(), json!(v));
            }
            if let Some(v) = config.frequency_penalty {
                obj.insert("penalty_freq".into(), json!(v));
            }
            if let Some(v) = config.presence_penalty {
                obj.insert("penalty_present".into(), json!(v));
            }
            if let Some(v) = config.min_p {
                obj.insert("min_p".into(), json!(v));
            }
            if let Some(v) = config.tfs_z {
                obj.insert("tfs_z".into(), json!(v));
            }
            if let Some(v) = config.typical_p {
                obj.insert("typical_p".into(), json!(v));
            }
            if let Some(v) = config.mirostat {
                obj.insert("mirostat".into(), json!(v));
            }
            if let Some(v) = config.mirostat_tau {
                obj.insert("mirostat_tau".into(), json!(v));
            }
            if let Some(v) = config.mirostat_eta {
                obj.insert("mirostat_eta".into(), json!(v));
            }
            if let Some(v) = config.repeat_last_n {
                obj.insert("penalty_last_n".into(), json!(v));
            }
            if let Some(v) = config.penalize_nl {
                obj.insert("penalize_nl".into(), json!(v));
            }
            if let Some(v) = config.n_keep {
                obj.insert("n_keep".into(), json!(v));
            }
            if let Some(v) = config.cache_prompt {
                obj.insert("cache_prompt".into(), json!(v));
            }
        }

        let res = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(ApiError::internal)?;

        if !res.status().is_success() {
            return Err(ApiError::internal(format!(
                "Llama server error: {}",
                res.status()
            )));
        }

        let data: Value = res.json().await.map_err(ApiError::internal)?;
        let content = extract_field_text(&data, &["content", "text", "response"]);
        let reasoning = extract_field_text(&data, &["reasoning", "reasoning_content", "thinking"]);
        Ok(compose_reasoned_content(&reasoning, &content))
    }

    pub async fn stream_chat(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
        timeout: Duration,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        self.ensure_running(config, timeout).await?;

        let manager = self.inner.lock().await;
        let url = format!("http://localhost:{}/completion", manager.port);
        drop(manager);

        let prompt = self.format_chat_prompt(messages);

        let mut body = json!({
            "prompt": prompt,
            "stream": true,
            "n_predict": config.predict_len.unwrap_or(1024),
            "temperature": config.temperature.unwrap_or(0.7),
            "top_p": config.top_p.unwrap_or(0.9),
            "top_k": config.top_k.unwrap_or(40),
            "repeat_penalty": config.repeat_penalty.unwrap_or(1.1),
        });
        // Add optional llama.cpp parameters
        if let Some(obj) = body.as_object_mut() {
            if let Some(v) = config.seed {
                obj.insert("seed".into(), json!(v));
            }
            if let Some(v) = config.frequency_penalty {
                obj.insert("penalty_freq".into(), json!(v));
            }
            if let Some(v) = config.presence_penalty {
                obj.insert("penalty_present".into(), json!(v));
            }
            if let Some(v) = config.min_p {
                obj.insert("min_p".into(), json!(v));
            }
            if let Some(v) = config.tfs_z {
                obj.insert("tfs_z".into(), json!(v));
            }
            if let Some(v) = config.typical_p {
                obj.insert("typical_p".into(), json!(v));
            }
            if let Some(v) = config.mirostat {
                obj.insert("mirostat".into(), json!(v));
            }
            if let Some(v) = config.mirostat_tau {
                obj.insert("mirostat_tau".into(), json!(v));
            }
            if let Some(v) = config.mirostat_eta {
                obj.insert("mirostat_eta".into(), json!(v));
            }
            if let Some(v) = config.repeat_last_n {
                obj.insert("penalty_last_n".into(), json!(v));
            }
            if let Some(v) = config.penalize_nl {
                obj.insert("penalize_nl".into(), json!(v));
            }
            if let Some(v) = config.n_keep {
                obj.insert("n_keep".into(), json!(v));
            }
            if let Some(v) = config.cache_prompt {
                obj.insert("cache_prompt".into(), json!(v));
            }
        }

        let (tx, rx) = mpsc::channel(100);
        let client = self.client.clone();

        tokio::spawn(async move {
            let mut is_reasoning_open = false;
            let mut res = match client.post(&url).json(&body).send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx.send(Err(ApiError::internal(e.to_string()))).await;
                    return;
                }
            };

            while let Some(chunk) = res.chunk().await.ok().flatten() {
                let text = String::from_utf8_lossy(&chunk);
                for line in text.lines() {
                    if let Some(json_str) = line.strip_prefix("data: ") {
                        if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                            let mut chunk_to_send = String::new();
                            let reasoning = extract_field_text(
                                &val,
                                &["reasoning", "reasoning_content", "thinking"],
                            );
                            if !reasoning.is_empty() {
                                if !is_reasoning_open {
                                    chunk_to_send.push_str("<think>\n");
                                    is_reasoning_open = true;
                                }
                                chunk_to_send.push_str(&reasoning);
                            }

                            let content =
                                extract_field_text(&val, &["content", "text", "response"]);
                            if !content.is_empty() {
                                if is_reasoning_open {
                                    chunk_to_send.push_str("\n</think>\n");
                                    is_reasoning_open = false;
                                }
                                chunk_to_send.push_str(&content);
                            }

                            if !chunk_to_send.is_empty()
                                && tx.send(Ok(chunk_to_send)).await.is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            }
            if is_reasoning_open {
                let _ = tx.send(Ok("\n</think>\n".to_string())).await;
            }
        });

        Ok(rx)
    }

    pub async fn embed(
        &self,
        config: &ModelRuntimeConfig,
        inputs: &[String],
        timeout: Duration,
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        self.ensure_running(config, timeout).await?;

        let manager = self.inner.lock().await;
        let url = format!("http://localhost:{}/embedding", manager.port);
        drop(manager);

        let mut results = Vec::new();
        for input in inputs {
            let body = json!({
                "content": input,
            });

            let res = self
                .client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(ApiError::internal)?;

            if !res.status().is_success() {
                return Err(ApiError::internal(format!(
                    "Llama server error: {}",
                    res.status()
                )));
            }

            let data: Value = res.json().await.map_err(ApiError::internal)?;
            let embedding: Vec<f32> = serde_json::from_value(data["embedding"].clone())
                .map_err(|_| ApiError::internal("Invalid embedding response"))?;
            results.push(embedding);
        }

        Ok(results)
    }

    fn format_chat_prompt(&self, messages: Vec<ChatMessage>) -> String {
        let mut prompt = String::new();
        for msg in messages {
            prompt.push_str(&format!("{}: {}\n", msg.role, msg.content));
        }
        prompt.push_str("Assistant: ");
        prompt
    }
}

fn compose_reasoned_content(reasoning: &str, content: &str) -> String {
    if reasoning.trim().is_empty() {
        content.to_string()
    } else if content.is_empty() {
        format!("<think>\n{}\n</think>", reasoning)
    } else {
        format!("<think>\n{}\n</think>\n{}", reasoning, content)
    }
}

fn extract_field_text(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(candidate) = value.get(*key) {
            let text = value_to_text(candidate);
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(value_to_text).collect::<Vec<_>>().join(""),
        Value::Object(obj) => {
            for key in ["text", "content", "reasoning", "thinking"] {
                if let Some(candidate) = obj.get(key) {
                    let text = value_to_text(candidate);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}
