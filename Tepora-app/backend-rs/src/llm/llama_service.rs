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

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::llm::external_loader_common::{
    health_check_interval, health_check_timeout, process_terminate_timeout, stream_channel_buffer,
    stream_internal_buffer,
};
use crate::models::types::ModelRuntimeConfig;

const DEFAULT_SERVER_PORT: u16 = 8080;

#[derive(Clone)]
pub struct LlamaService {
    inner: Arc<Mutex<LlamaManager>>,
    client: Client,
    config: Option<ConfigService>,
}

struct LlamaManager {
    child_process: Option<Child>,
    port: u16,
    running: Arc<AtomicBool>,
    server_path: PathBuf,
    model_config: Option<ModelRuntimeConfig>,
}

struct PendingLlamaProcess {
    child: Child,
    port: u16,
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

use crate::llm::types::{ChatMessage, NormalizedAssistantTurn, NormalizedStreamChunk};

// Removed duplicate struct ChatMessage

impl LlamaService {
    pub fn new(paths: Arc<AppPaths>) -> Result<Self, ApiError> {
        Self::new_with_config(paths, Option::<ConfigService>::None)
    }

    pub fn new_with_config(
        paths: Arc<AppPaths>,
        config: impl Into<Option<ConfigService>>,
    ) -> Result<Self, ApiError> {
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
            config: config.into(),
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
                if should_reuse_running_config(current, config) {
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
        let pending = self.spawn_pending_process(manager, config)?;
        self.complete_startup(
            manager,
            config,
            pending,
            resolved_health_timeout(self.config.as_ref()),
            resolved_health_interval(self.config.as_ref()),
            resolved_shutdown_timeout(self.config.as_ref()),
        )
        .await
    }

    fn spawn_pending_process(
        &self,
        manager: &LlamaManager,
        config: &ModelRuntimeConfig,
    ) -> Result<PendingLlamaProcess, ApiError> {
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

        Ok(PendingLlamaProcess { child, port })
    }

    async fn complete_startup(
        &self,
        manager: &mut LlamaManager,
        config: &ModelRuntimeConfig,
        mut pending: PendingLlamaProcess,
        health_timeout: Duration,
        health_interval: Duration,
        shutdown_timeout: Duration,
    ) -> Result<(), ApiError> {
        if let Err(err) = self
            .wait_for_health_with_settings(pending.port, health_timeout, health_interval)
            .await
        {
            terminate_child_process(&mut pending.child, shutdown_timeout).await;
            return Err(err);
        }

        manager.port = pending.port;
        manager.model_config = Some(config.clone());
        manager.running.store(true, Ordering::SeqCst);
        manager.child_process = Some(pending.child);
        Ok(())
    }

    async fn stop_internal(
        &self,
        manager: &mut LlamaManager,
        timeout: Duration,
    ) -> Result<(), ApiError> {
        if let Some(mut child) = manager.child_process.take() {
            terminate_child_process(&mut child, timeout).await;
        }
        manager.running.store(false, Ordering::SeqCst);
        manager.model_config = None;
        Ok(())
    }

    async fn wait_for_health_with_settings(
        &self,
        port: u16,
        total_timeout: Duration,
        interval: Duration,
    ) -> Result<(), ApiError> {
        let url = format!("http://localhost:{}/health", port);
        let started = tokio::time::Instant::now();

        while started.elapsed() < total_timeout {
            if let Ok(response) = self.client.get(&url).send().await {
                if response.status().is_success() {
                    return Ok(());
                }
            }
            tokio::time::sleep(interval).await;
        }
        Err(ApiError::internal(format!(
            "Timed out waiting for llama-server after {} ms",
            total_timeout.as_millis()
        )))
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

    pub async fn chat_normalized(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
        timeout: Duration,
    ) -> Result<NormalizedAssistantTurn, ApiError> {
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
        Ok(NormalizedAssistantTurn {
            visible_text: extract_field_text(&data, &["content", "text", "response"]),
            model_thinking: extract_field_text(
                &data,
                &["reasoning", "reasoning_content", "thinking"],
            ),
            finish_reason: data
                .get("stop_type")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            usage: None,
        })
    }

    pub async fn chat(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
        timeout: Duration,
    ) -> Result<String, ApiError> {
        let normalized = self.chat_normalized(config, messages, timeout).await?;
        Ok(compose_reasoned_content(
            &normalized.model_thinking,
            &normalized.visible_text,
        ))
    }

    pub async fn stream_chat_normalized(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
        timeout: Duration,
    ) -> Result<mpsc::Receiver<Result<NormalizedStreamChunk, ApiError>>, ApiError> {
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

        let buffer_capacity = self
            .config
            .as_ref()
            .map(stream_internal_buffer)
            .unwrap_or(100);
        let (tx, rx) = mpsc::channel(buffer_capacity);
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
                    if let Some(json_str) = line.strip_prefix("data: ") {
                        if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                            let reasoning = extract_field_text(
                                &val,
                                &["reasoning", "reasoning_content", "thinking"],
                            );
                            let content =
                                extract_field_text(&val, &["content", "text", "response"]);
                            let done = val.get("stop").and_then(|value| value.as_bool())
                                == Some(true)
                                || val.get("stopped_eos").and_then(|value| value.as_bool())
                                    == Some(true)
                                || val.get("stopped_word").and_then(|value| value.as_bool())
                                    == Some(true);

                            if (!reasoning.is_empty() || !content.is_empty() || done)
                                && tx
                                    .send(Ok(NormalizedStreamChunk {
                                        visible_text: content,
                                        model_thinking: reasoning,
                                        done,
                                        usage: None,
                                    }))
                                    .await
                                    .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            }
            let _ = tx
                .send(Ok(NormalizedStreamChunk {
                    visible_text: String::new(),
                    model_thinking: String::new(),
                    done: true,
                    usage: None,
                }))
                .await;
        });

        Ok(rx)
    }

    pub async fn stream_chat(
        &self,
        config: &ModelRuntimeConfig,
        messages: Vec<ChatMessage>,
        timeout: Duration,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let mut normalized = self
            .stream_chat_normalized(config, messages, timeout)
            .await?;
        let buffer_capacity = self
            .config
            .as_ref()
            .map(stream_channel_buffer)
            .unwrap_or(128);
        let (tx, rx) = mpsc::channel(buffer_capacity);
        tokio::spawn(async move {
            while let Some(item) = normalized.recv().await {
                match item {
                    Ok(chunk) => {
                        let merged =
                            compose_reasoned_content(&chunk.model_thinking, &chunk.visible_text);
                        if (!merged.is_empty() || chunk.done) && tx.send(Ok(merged)).await.is_err()
                        {
                            return;
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(Err(err)).await;
                        return;
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

fn should_reuse_running_config(
    current: &ModelRuntimeConfig,
    requested: &ModelRuntimeConfig,
) -> bool {
    current.model_path == requested.model_path
        && current.port == requested.port
        && current.n_ctx == requested.n_ctx
        && current.n_gpu_layers == requested.n_gpu_layers
}

fn resolved_health_timeout(config: Option<&ConfigService>) -> Duration {
    config
        .map(health_check_timeout)
        .unwrap_or_else(|| Duration::from_secs(15))
}

fn resolved_health_interval(config: Option<&ConfigService>) -> Duration {
    config
        .map(health_check_interval)
        .unwrap_or_else(|| Duration::from_millis(500))
}

fn resolved_shutdown_timeout(config: Option<&ConfigService>) -> Duration {
    config
        .map(process_terminate_timeout)
        .unwrap_or_else(|| Duration::from_secs(5))
}

async fn terminate_child_process(child: &mut Child, timeout: Duration) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn runtime_config() -> ModelRuntimeConfig {
        ModelRuntimeConfig {
            model_key: "text_model".to_string(),
            model_path: PathBuf::from("/tmp/model.gguf"),
            port: DEFAULT_SERVER_PORT,
            n_ctx: 2048,
            n_gpu_layers: -1,
            predict_len: Some(1024),
            temperature: Some(0.7),
            top_p: Some(0.9),
            top_k: None,
            repeat_penalty: None,
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
        }
    }

    fn test_manager() -> LlamaManager {
        LlamaManager {
            child_process: None,
            port: DEFAULT_SERVER_PORT,
            running: Arc::new(AtomicBool::new(false)),
            server_path: PathBuf::from("llama-server"),
            model_config: None,
        }
    }

    #[test]
    fn should_reuse_running_config_only_checks_startup_fields() {
        let current = runtime_config();
        let mut sampling_change = runtime_config();
        sampling_change.temperature = Some(0.2);
        sampling_change.predict_len = Some(32);
        assert!(should_reuse_running_config(&current, &sampling_change));

        let mut port_change = runtime_config();
        port_change.port = 9001;
        assert!(!should_reuse_running_config(&current, &port_change));

        let mut ctx_change = runtime_config();
        ctx_change.n_ctx = 4096;
        assert!(!should_reuse_running_config(&current, &ctx_change));

        let mut gpu_change = runtime_config();
        gpu_change.n_gpu_layers = 16;
        assert!(!should_reuse_running_config(&current, &gpu_change));
    }

    #[tokio::test]
    async fn complete_startup_cleans_up_failed_health_check_without_mutating_manager() {
        let paths = Arc::new(AppPaths::new());
        let service = LlamaService::new(paths).unwrap();
        let mut manager = test_manager();
        let config = runtime_config();

        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 5")
            .spawn()
            .unwrap();

        let result = service
            .complete_startup(
                &mut manager,
                &config,
                PendingLlamaProcess { child, port: 9 },
                Duration::from_millis(25),
                Duration::from_millis(10),
                Duration::from_millis(100),
            )
            .await;

        assert!(result.is_err());
        assert!(!manager.running.load(Ordering::SeqCst));
        assert!(manager.child_process.is_none());
        assert!(manager.model_config.is_none());
        assert_eq!(manager.port, DEFAULT_SERVER_PORT);
    }

    #[tokio::test]
    async fn complete_startup_can_retry_after_previous_failure() {
        let paths = Arc::new(AppPaths::new());
        let service = LlamaService::new(paths).unwrap();
        let mut manager = test_manager();
        let config = runtime_config();

        for _ in 0..2 {
            let child = Command::new("/bin/sh")
                .arg("-c")
                .arg("sleep 5")
                .spawn()
                .unwrap();

            let result = service
                .complete_startup(
                    &mut manager,
                    &config,
                    PendingLlamaProcess { child, port: 9 },
                    Duration::from_millis(25),
                    Duration::from_millis(10),
                    Duration::from_millis(100),
                )
                .await;

            assert!(result.is_err());
            assert!(!manager.running.load(Ordering::SeqCst));
            assert!(manager.child_process.is_none());
            assert!(manager.model_config.is_none());
        }
    }
}
