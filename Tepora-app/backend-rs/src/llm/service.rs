use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::llm::llama_service::LlamaService;
use crate::llm::types::{ChatMessage, ChatRequest};
use crate::models::types::{ModelEntry, ModelRuntimeConfig};
use crate::models::ModelManager;

#[derive(Debug)]
enum ModelExecutionTarget {
    LlamaCpp(ModelRuntimeConfig),
    OpenAiCompatible {
        loader: String,
        base_url: String,
        model_name: String,
    },
}

const DEFAULT_PROCESS_TERMINATE_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_EXTERNAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_EXTERNAL_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct LlmService {
    models: ModelManager,
    llama: LlamaService,
    config: ConfigService,
    http: Client,
}

impl LlmService {
    pub fn new(models: ModelManager, llama: LlamaService, config: ConfigService) -> Self {
        Self {
            models,
            llama,
            config,
            http: Client::new(),
        }
    }

    pub async fn chat(&self, request: ChatRequest, model_id: &str) -> Result<String, ApiError> {
        let target = self.resolve_model_target(model_id, &request)?;
        match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = self.get_process_terminate_timeout();
                let messages = request
                    .messages
                    .iter()
                    .map(|m| ChatMessage {
                        role: m.role.clone(),
                        content: m.content.clone(),
                    })
                    .collect();
                self.llama.chat(&config, messages, timeout).await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                self.chat_openai_compatible(&loader, &base_url, &model_name, request)
                    .await
            }
        }
    }

    pub async fn stream_chat(
        &self,
        request: ChatRequest,
        model_id: &str,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let target = self.resolve_model_target(model_id, &request)?;
        match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = self.get_process_terminate_timeout();
                let messages = request
                    .messages
                    .iter()
                    .map(|m| ChatMessage {
                        role: m.role.clone(),
                        content: m.content.clone(),
                    })
                    .collect();
                self.llama.stream_chat(&config, messages, timeout).await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                self.stream_chat_openai_compatible(&loader, &base_url, &model_name, request)
                    .await
            }
        }
    }

    pub async fn embed(
        &self,
        inputs: &[String],
        model_id: &str,
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        let target = self.resolve_model_target(model_id, &ChatRequest::new(vec![]))?;
        match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = self.get_process_terminate_timeout();
                self.llama.embed(&config, inputs, timeout).await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                self.embed_openai_compatible(&loader, &base_url, &model_name, inputs)
                    .await
            }
        }
    }

    fn get_process_terminate_timeout(&self) -> Duration {
        if let Ok(config) = self.config.load_config() {
            if let Some(val) = config
                .get("llm_manager")
                .and_then(|m| m.get("process_terminate_timeout"))
                .and_then(|v| v.as_u64())
            {
                return Duration::from_millis(val);
            }
        }
        DEFAULT_PROCESS_TERMINATE_TIMEOUT
    }

    fn get_external_loader_request_timeout(&self) -> Duration {
        if let Ok(config) = self.config.load_config() {
            if let Some(val) = config
                .get("llm_manager")
                .and_then(|m| {
                    m.get("external_request_timeout_ms")
                        .or_else(|| m.get("health_check_timeout"))
                })
                .and_then(|v| v.as_u64())
            {
                return Duration::from_millis(val.max(1));
            }
        }
        DEFAULT_EXTERNAL_REQUEST_TIMEOUT
    }

    fn get_external_loader_stream_idle_timeout(&self) -> Duration {
        if let Ok(config) = self.config.load_config() {
            if let Some(val) = config
                .get("llm_manager")
                .and_then(|m| m.get("stream_idle_timeout_ms"))
                .and_then(|v| v.as_u64())
            {
                return Duration::from_millis(val.max(1));
            }
        }
        DEFAULT_EXTERNAL_STREAM_IDLE_TIMEOUT
    }

    fn resolve_model_target(
        &self,
        model_id: &str,
        request: &ChatRequest,
    ) -> Result<ModelExecutionTarget, ApiError> {
        let model_entry = self
            .models
            .get_model(model_id)?
            .ok_or_else(|| ApiError::BadRequest(format!("Model not found: {}", model_id)))?;
        let config = self.config.load_config().unwrap_or(Value::Null);
        let loader = normalize_loader_name(&model_entry);

        match loader.as_str() {
            "ollama" => {
                let model_name =
                    resolve_loader_model_name(&model_entry, "ollama://").ok_or_else(|| {
                        ApiError::BadRequest(format!(
                            "Model '{}' has no resolvable Ollama model name",
                            model_id
                        ))
                    })?;
                let base_url =
                    loader_base_url(&config, "ollama", "http://localhost:11434".to_string());
                Ok(ModelExecutionTarget::OpenAiCompatible {
                    loader,
                    base_url,
                    model_name,
                })
            }
            "lmstudio" => {
                let model_name =
                    resolve_loader_model_name(&model_entry, "lmstudio://").ok_or_else(|| {
                        ApiError::BadRequest(format!(
                            "Model '{}' has no resolvable LM Studio model name",
                            model_id
                        ))
                    })?;
                let base_url =
                    loader_base_url(&config, "lmstudio", "http://localhost:1234".to_string());
                Ok(ModelExecutionTarget::OpenAiCompatible {
                    loader,
                    base_url,
                    model_name,
                })
            }
            "llama_cpp" => {
                let model_config = self.resolve_llama_model_config(&model_entry, &config, request)?;
                Ok(ModelExecutionTarget::LlamaCpp(model_config))
            }
            other => Err(ApiError::BadRequest(format!(
                "Model '{}' has unsupported loader '{}'. Supported loaders are: llama_cpp, ollama, lmstudio",
                model_id, other
            ))),
        }
    }

    fn resolve_llama_model_config(
        &self,
        model_entry: &ModelEntry,
        app_config: &Value,
        request: &ChatRequest,
    ) -> Result<ModelRuntimeConfig, ApiError> {
        if model_entry.file_path.starts_with("ollama://")
            || model_entry.file_path.starts_with("lmstudio://")
        {
            return Err(ApiError::BadRequest(format!(
                "Model '{}' points to remote URI '{}', but was routed to llama.cpp",
                model_entry.id, model_entry.file_path
            )));
        }

        let models_config = app_config.get("models_gguf");
        let text_model_defaults = models_config.and_then(|m| m.get("text_model"));
        let embedding_model_defaults = models_config.and_then(|m| m.get("embedding_model"));

        let defaults = if model_entry.role == "embedding" {
            embedding_model_defaults
        } else {
            text_model_defaults
        };

        let n_ctx = defaults
            .and_then(|v| v.get("n_ctx").and_then(|x| x.as_u64()))
            .unwrap_or(2048) as usize;
        let n_gpu_layers = defaults
            .and_then(|v| v.get("n_gpu_layers").and_then(|x| x.as_i64()))
            .unwrap_or(-1) as i32;
        let port = defaults
            .and_then(|v| v.get("port").and_then(|x| x.as_u64()))
            .unwrap_or(if model_entry.role == "embedding" {
                8090
            } else {
                8088
            }) as u16;

        let predict_len = request.max_tokens.map(|v| v as usize);
        let temperature = request.temperature.map(|v| v as f32);
        let top_p = request.top_p.map(|v| v as f32);
        let top_k = request.top_k.map(|v| v as i32);
        let repeat_penalty = request.repeat_penalty.map(|v| v as f32);

        Ok(ModelRuntimeConfig {
            model_key: model_entry.id.clone(),
            model_path: PathBuf::from(model_entry.file_path.clone()),
            port,
            n_ctx,
            n_gpu_layers,
            predict_len,
            temperature,
            top_p,
            top_k,
            repeat_penalty,
        })
    }

    async fn chat_openai_compatible(
        &self,
        loader: &str,
        base_url: &str,
        model_name: &str,
        request: ChatRequest,
    ) -> Result<String, ApiError> {
        let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
        let mut body = json!({
            "model": model_name,
            "messages": request.messages,
            "stream": false,
        });
        if let Some(obj) = body.as_object_mut() {
            if let Some(v) = request.temperature {
                obj.insert("temperature".to_string(), json!(v));
            }
            if let Some(v) = request.top_p {
                obj.insert("top_p".to_string(), json!(v));
            }
            if let Some(v) = request.top_k {
                obj.insert("top_k".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_penalty {
                obj.insert("repeat_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.max_tokens {
                obj.insert("max_tokens".to_string(), json!(v));
            }
        }

        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&body);
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error(loader, &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error(loader, base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "{} chat request failed ({}): {}",
                loader, status, text
            )));
        }

        let payload: Value = response.json().await.map_err(ApiError::internal)?;
        let content = payload
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        Ok(content)
    }

    async fn stream_chat_openai_compatible(
        &self,
        loader: &str,
        base_url: &str,
        model_name: &str,
        request: ChatRequest,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
        let mut body = json!({
            "model": model_name,
            "messages": request.messages,
            "stream": true,
        });
        if let Some(obj) = body.as_object_mut() {
            if let Some(v) = request.temperature {
                obj.insert("temperature".to_string(), json!(v));
            }
            if let Some(v) = request.top_p {
                obj.insert("top_p".to_string(), json!(v));
            }
            if let Some(v) = request.top_k {
                obj.insert("top_k".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_penalty {
                obj.insert("repeat_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.max_tokens {
                obj.insert("max_tokens".to_string(), json!(v));
            }
        }

        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&body);
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error(loader, &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error(loader, base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "{} streaming request failed ({}): {}",
                loader, status, text
            )));
        }

        let (tx, rx) = mpsc::channel(128);
        let mut byte_stream = response.bytes_stream();
        let stream_idle_timeout = self.get_external_loader_stream_idle_timeout();
        let loader_name = loader.to_string();
        tokio::spawn(async move {
            let mut buffer = String::new();
            loop {
                let next = tokio::time::timeout(stream_idle_timeout, byte_stream.next()).await;
                let next = match next {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = tx
                            .send(Err(ApiError::Internal(format!(
                                "{} stream idle timeout after {} ms",
                                loader_name,
                                stream_idle_timeout.as_millis()
                            ))))
                            .await;
                        return;
                    }
                };

                let Some(next) = next else {
                    break;
                };

                match next {
                    Ok(bytes) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));

                        while let Some(newline_index) = buffer.find('\n') {
                            let line = buffer[..newline_index].trim().to_string();
                            buffer = buffer[(newline_index + 1)..].to_string();

                            if line.is_empty() {
                                continue;
                            }
                            if line == "data: [DONE]" {
                                return;
                            }

                            let Some(data) = line.strip_prefix("data: ") else {
                                continue;
                            };
                            let parsed = match serde_json::from_str::<Value>(data) {
                                Ok(value) => value,
                                Err(err) => {
                                    let _ = tx
                                        .send(Err(ApiError::Internal(format!(
                                            "Invalid streaming payload: {}",
                                            err
                                        ))))
                                        .await;
                                    return;
                                }
                            };

                            if let Some(content) = parsed
                                .get("choices")
                                .and_then(|v| v.as_array())
                                .and_then(|choices| choices.first())
                                .and_then(|choice| choice.get("delta"))
                                .and_then(|delta| delta.get("content"))
                                .and_then(|v| v.as_str())
                            {
                                if !content.is_empty()
                                    && tx.send(Ok(content.to_string())).await.is_err()
                                {
                                    return;
                                }
                            }
                        }
                    }
                    Err(err) => {
                        let _ = tx
                            .send(Err(ApiError::Internal(format!(
                                "Streaming transport failed: {}",
                                err
                            ))))
                            .await;
                        return;
                    }
                }
            }

            let trailing = buffer.trim();
            if trailing.is_empty() || trailing == "data: [DONE]" {
                return;
            }
            if let Some(data) = trailing.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    if let Some(content) = parsed
                        .get("choices")
                        .and_then(|v| v.as_array())
                        .and_then(|choices| choices.first())
                        .and_then(|choice| choice.get("delta"))
                        .and_then(|delta| delta.get("content"))
                        .and_then(|v| v.as_str())
                    {
                        let _ = tx.send(Ok(content.to_string())).await;
                    }
                }
            }
        });

        Ok(rx)
    }

    async fn embed_openai_compatible(
        &self,
        loader: &str,
        base_url: &str,
        model_name: &str,
        inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, ApiError> {
        let endpoint = format!("{}/v1/embeddings", base_url.trim_end_matches('/'));
        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&json!({
            "model": model_name,
            "input": inputs,
        }));
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error(loader, &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error(loader, base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "{} embedding request failed ({}): {}",
                loader, status, text
            )));
        }

        let payload: Value = response.json().await.map_err(ApiError::internal)?;
        let mut embeddings = Vec::new();
        if let Some(items) = payload.get("data").and_then(|v| v.as_array()) {
            for item in items {
                let vector = item
                    .get("embedding")
                    .and_then(|v| v.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| value.as_f64().map(|f| f as f32))
                            .collect::<Vec<f32>>()
                    })
                    .unwrap_or_default();
                embeddings.push(vector);
            }
        }
        Ok(embeddings)
    }
}

fn normalize_loader_name(model: &ModelEntry) -> String {
    let direct = model.loader.trim().to_ascii_lowercase();
    if !direct.is_empty() {
        return direct;
    }

    if model.file_path.starts_with("ollama://") || model.source.eq_ignore_ascii_case("ollama") {
        return "ollama".to_string();
    }
    if model.file_path.starts_with("lmstudio://") || model.source.eq_ignore_ascii_case("lmstudio") {
        return "lmstudio".to_string();
    }
    "llama_cpp".to_string()
}

fn resolve_loader_model_name(model: &ModelEntry, scheme_prefix: &str) -> Option<String> {
    if let Some(name) = model
        .loader_model_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(name.to_string());
    }

    if let Some(name) = model
        .file_path
        .strip_prefix(scheme_prefix)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(name.to_string());
    }

    let filename = model.filename.trim();
    if filename.is_empty() {
        return None;
    }
    Some(filename.to_string())
}

fn loader_base_url(config: &Value, loader: &str, default_url: String) -> String {
    config
        .get("loaders")
        .and_then(|v| v.get(loader))
        .and_then(|v| v.get("base_url"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
        .unwrap_or(default_url)
}

fn unreachable_loader_error(loader: &str, base_url: &str, err: reqwest::Error) -> ApiError {
    ApiError::Internal(format!(
        "Failed to reach '{}' loader at {}: {}",
        loader, base_url, err
    ))
}

fn loader_timeout_error(loader: &str, endpoint: &str, timeout: Duration, phase: &str) -> ApiError {
    ApiError::Internal(format!(
        "{} {} timed out after {} ms ({})",
        loader,
        phase,
        timeout.as_millis(),
        endpoint
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::ModelEntry;
    use serde_json::json;

    fn model_entry(loader: &str, source: &str, file_path: &str) -> ModelEntry {
        ModelEntry {
            id: "model-1".to_string(),
            display_name: "Model 1".to_string(),
            role: "text".to_string(),
            file_size: 1,
            filename: "model-name".to_string(),
            source: source.to_string(),
            file_path: file_path.to_string(),
            loader: loader.to_string(),
            loader_model_name: None,
            repo_id: None,
            revision: None,
            sha256: None,
            added_at: "2026-01-01T00:00:00Z".to_string(),
            parameter_size: None,
            quantization: None,
            context_length: None,
            architecture: None,
            chat_template: None,
            stop_tokens: None,
            default_temperature: None,
            capabilities: None,
            publisher: None,
            description: None,
            format: None,
        }
    }

    #[test]
    fn normalize_loader_prefers_explicit_loader() {
        let entry = model_entry("lmstudio", "local", "models/text/model.gguf");
        assert_eq!(normalize_loader_name(&entry), "lmstudio");
    }

    #[test]
    fn normalize_loader_infers_from_uri_scheme() {
        let entry = model_entry("", "local", "ollama://qwen3:latest");
        assert_eq!(normalize_loader_name(&entry), "ollama");
    }

    #[test]
    fn normalize_loader_preserves_unknown_loader_value() {
        let entry = model_entry("custom_loader", "local", "models/text/model.gguf");
        assert_eq!(normalize_loader_name(&entry), "custom_loader");
    }

    #[test]
    fn resolve_loader_model_name_prefers_loader_model_name() {
        let mut entry = model_entry("ollama", "ollama", "ollama://ignored");
        entry.loader_model_name = Some("real-name:latest".to_string());
        assert_eq!(
            resolve_loader_model_name(&entry, "ollama://").as_deref(),
            Some("real-name:latest")
        );
    }

    #[test]
    fn resolve_loader_model_name_falls_back_to_uri() {
        let entry = model_entry("ollama", "ollama", "ollama://qwen3:latest");
        assert_eq!(
            resolve_loader_model_name(&entry, "ollama://").as_deref(),
            Some("qwen3:latest")
        );
    }

    #[test]
    fn loader_base_url_uses_config_override() {
        let config = json!({
            "loaders": {
                "ollama": {
                    "base_url": "http://127.0.0.1:11434/"
                }
            }
        });
        assert_eq!(
            loader_base_url(&config, "ollama", "http://localhost:11434".to_string()),
            "http://127.0.0.1:11434"
        );
    }

    #[test]
    fn loader_base_url_uses_default_when_missing() {
        let config = json!({});
        assert_eq!(
            loader_base_url(&config, "lmstudio", "http://localhost:1234".to_string()),
            "http://localhost:1234"
        );
    }
}
