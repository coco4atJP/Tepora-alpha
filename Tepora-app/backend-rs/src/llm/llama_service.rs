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

    pub async fn ensure_running(&self, config: &ModelRuntimeConfig) -> Result<(), ApiError> {
        let mut manager = self.inner.lock().await;

        if manager.running.load(Ordering::SeqCst) {
            if let Some(current) = &manager.model_config {
                if current.model_path == config.model_path {
                    return Ok(());
                }
            }
            self.stop_internal(&mut manager).await?;
        }

        self.start_internal(&mut manager, config).await?;
        Ok(())
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

    async fn stop_internal(&self, manager: &mut LlamaManager) -> Result<(), ApiError> {
        if let Some(mut child) = manager.child_process.take() {
            let _ = child.kill().await;
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

    pub async fn chat(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
    ) -> Result<String, ApiError> {
        self.ensure_running(config).await?;

        let manager = self.inner.lock().await;
        let url = format!("http://localhost:{}/completion", manager.port);
        drop(manager);

        let prompt = self.format_chat_prompt(messages);

        let body = json!({
            "prompt": prompt,
            "stream": false,
            "n_predict": config.predict_len.unwrap_or(1024),
            "temperature": config.temperature.unwrap_or(0.7),
            "stop": ["User:", "System:"]
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
        let content = data["content"].as_str().unwrap_or("").to_string();
        Ok(content)
    }

    pub async fn stream_chat(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        self.ensure_running(config).await?;

        let manager = self.inner.lock().await;
        let url = format!("http://localhost:{}/completion", manager.port);
        drop(manager);

        let prompt = self.format_chat_prompt(messages);

        let body = json!({
            "prompt": prompt,
            "stream": true,
            "n_predict": config.predict_len.unwrap_or(1024),
            "temperature": config.temperature.unwrap_or(0.7),
        });

        let (tx, rx) = mpsc::channel(100);
        let client = self.client.clone();

        tokio::spawn(async move {
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
                    if line.starts_with("data: ") {
                        let json_str = &line[6..];
                        if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                            if let Some(content) = val["content"].as_str() {
                                if let Err(_) = tx.send(Ok(content.to_string())).await {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(rx)
    }

    pub async fn embed(
        &self,
        config: &ModelRuntimeConfig,
        inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        self.ensure_running(config).await?;

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
