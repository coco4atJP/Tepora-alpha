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
const DEFAULT_EXTERNAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
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
                if loader.eq_ignore_ascii_case("ollama") {
                    match self
                        .chat_ollama_native(&base_url, &model_name, request.clone())
                        .await
                    {
                        Ok(content) => Ok(content),
                        Err(err) => {
                            tracing::warn!(
                                "Ollama native chat failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            self.chat_openai_compatible(&loader, &base_url, &model_name, request)
                                .await
                        }
                    }
                } else if loader.eq_ignore_ascii_case("lmstudio") {
                    match self
                        .chat_lmstudio_native(&base_url, &model_name, request.clone())
                        .await
                    {
                        Ok(content) => Ok(content),
                        Err(err) => {
                            tracing::warn!(
                                "LM Studio native chat failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            self.chat_openai_compatible(&loader, &base_url, &model_name, request)
                                .await
                        }
                    }
                } else {
                    self.chat_openai_compatible(&loader, &base_url, &model_name, request)
                        .await
                }
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
                if loader.eq_ignore_ascii_case("ollama") {
                    match self
                        .stream_chat_ollama_native(&base_url, &model_name, request.clone())
                        .await
                    {
                        Ok(stream) => Ok(stream),
                        Err(err) => {
                            tracing::warn!(
                                "Ollama native stream failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            self.stream_chat_openai_compatible(
                                &loader,
                                &base_url,
                                &model_name,
                                request,
                            )
                            .await
                        }
                    }
                } else if loader.eq_ignore_ascii_case("lmstudio") {
                    match self
                        .stream_chat_lmstudio_native(&base_url, &model_name, request.clone())
                        .await
                    {
                        Ok(stream) => Ok(stream),
                        Err(err) => {
                            tracing::warn!(
                                "LM Studio native stream failed, falling back to OpenAI-compatible API: {}",
                                err
                            );
                            self.stream_chat_openai_compatible(
                                &loader,
                                &base_url,
                                &model_name,
                                request,
                            )
                            .await
                        }
                    }
                } else {
                    self.stream_chat_openai_compatible(&loader, &base_url, &model_name, request)
                        .await
                }
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

    /// Fetches the logprobs for a given text.
    /// This is required for true EM-LLM surprise-based segmentation.
    /// Currently, this returns an 'Unsupported' error to trigger the fallback, but serves as the API hook.
    pub async fn get_logprobs(
        &self,
        text: &str,
        model_id: &str,
    ) -> Result<Vec<(String, f64)>, ApiError> {
        let request = ChatRequest::new(vec![]);
        let target = self.resolve_model_target(model_id, &request)?;
        match target {
            ModelExecutionTarget::LlamaCpp(config) => {
                let timeout = self.get_process_terminate_timeout();
                self.llama.get_logprobs(&config, text, timeout).await
            }
            ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            } => {
                self.get_logprobs_openai_compatible(&loader, &base_url, &model_name, text)
                    .await
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), ApiError> {
        let timeout = self.get_process_terminate_timeout();
        self.llama.stop(timeout).await
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
        let stop = request
            .stop
            .clone()
            .or_else(|| model_entry.stop_tokens.clone());

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
            stop,
            seed: request.seed,
            frequency_penalty: request.frequency_penalty.map(|v| v as f32),
            presence_penalty: request.presence_penalty.map(|v| v as f32),
            min_p: request.min_p.map(|v| v as f32),
            tfs_z: request.tfs_z.map(|v| v as f32),
            typical_p: request.typical_p.map(|v| v as f32),
            mirostat: request.mirostat,
            mirostat_tau: request.mirostat_tau.map(|v| v as f32),
            mirostat_eta: request.mirostat_eta.map(|v| v as f32),
            repeat_last_n: request.repeat_last_n,
            penalize_nl: request.penalize_nl,
            n_keep: request.n_keep,
            cache_prompt: request.cache_prompt,
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
            if let Some(ref v) = request.stop {
                obj.insert("stop".to_string(), json!(v));
            }
            if let Some(v) = request.seed {
                obj.insert("seed".to_string(), json!(v));
            }
            if let Some(v) = request.frequency_penalty {
                obj.insert("frequency_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.presence_penalty {
                obj.insert("presence_penalty".to_string(), json!(v));
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
            .map(|message| {
                let text = extract_field_text(message, &["content", "text"]);
                let reasoning =
                    extract_field_text(message, &["reasoning", "reasoning_content", "thinking"]);
                compose_reasoned_content(&reasoning, &text)
            })
            .unwrap_or_default();

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
            if let Some(ref v) = request.stop {
                obj.insert("stop".to_string(), json!(v));
            }
            if let Some(v) = request.seed {
                obj.insert("seed".to_string(), json!(v));
            }
            if let Some(v) = request.frequency_penalty {
                obj.insert("frequency_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.presence_penalty {
                obj.insert("presence_penalty".to_string(), json!(v));
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
            let mut is_reasoning_open = false;
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
                                if is_reasoning_open {
                                    let _ = tx.send(Ok("\n</think>\n".to_string())).await;
                                }
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

                            let delta = parsed
                                .get("choices")
                                .and_then(|v| v.as_array())
                                .and_then(|choices| choices.first())
                                .and_then(|choice| choice.get("delta"));

                            let mut chunk_to_send = String::new();

                            // Track reasoning/thinking content from OpenAI-compatible variants
                            let reasoning = delta
                                .map(|d| {
                                    extract_field_text(
                                        d,
                                        &["reasoning", "reasoning_content", "thinking"],
                                    )
                                })
                                .unwrap_or_default();
                            if !reasoning.is_empty() {
                                if !is_reasoning_open {
                                    chunk_to_send.push_str("<think>\n");
                                    is_reasoning_open = true;
                                }
                                chunk_to_send.push_str(&reasoning);
                            }

                            // Track standard content
                            let content = delta
                                .map(|d| extract_field_text(d, &["content", "text"]))
                                .unwrap_or_default();
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
                    let delta = parsed
                        .get("choices")
                        .and_then(|v| v.as_array())
                        .and_then(|choices| choices.first())
                        .and_then(|choice| choice.get("delta"));

                    let mut chunk_to_send = String::new();

                    let reasoning = delta
                        .map(|d| {
                            extract_field_text(d, &["reasoning", "reasoning_content", "thinking"])
                        })
                        .unwrap_or_default();
                    if !reasoning.is_empty() {
                        if !is_reasoning_open {
                            chunk_to_send.push_str("<think>\n");
                            is_reasoning_open = true;
                        }
                        chunk_to_send.push_str(&reasoning);
                    }

                    let content = delta
                        .map(|d| extract_field_text(d, &["content", "text"]))
                        .unwrap_or_default();
                    if !content.is_empty() {
                        if is_reasoning_open {
                            chunk_to_send.push_str("\n</think>\n");
                            is_reasoning_open = false;
                        }
                        chunk_to_send.push_str(&content);
                    }

                    if !chunk_to_send.is_empty() {
                        let _ = tx.send(Ok(chunk_to_send)).await;
                    }
                }
            }
            if is_reasoning_open {
                let _ = tx.send(Ok("\n</think>\n".to_string())).await;
            }
        });

        Ok(rx)
    }

    async fn chat_ollama_native(
        &self,
        base_url: &str,
        model_name: &str,
        request: ChatRequest,
    ) -> Result<String, ApiError> {
        let endpoint = format!("{}/api/chat", base_url.trim_end_matches('/'));
        let mut body = json!({
            "model": model_name,
            "messages": request.messages,
            "stream": false,
            "think": true,
        });

        if let Some(obj) = body.as_object_mut() {
            let mut options = serde_json::Map::new();
            if let Some(v) = request.temperature {
                options.insert("temperature".to_string(), json!(v));
            }
            if let Some(v) = request.top_p {
                options.insert("top_p".to_string(), json!(v));
            }
            if let Some(v) = request.top_k {
                options.insert("top_k".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_penalty {
                options.insert("repeat_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.max_tokens {
                options.insert("num_predict".to_string(), json!(v));
            }
            // Common parameters
            if let Some(v) = request.seed {
                options.insert("seed".to_string(), json!(v));
            }
            if let Some(v) = request.frequency_penalty {
                options.insert("frequency_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.presence_penalty {
                options.insert("presence_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.min_p {
                options.insert("min_p".to_string(), json!(v));
            }
            // Ollama-specific sampling parameters
            if let Some(v) = request.tfs_z {
                options.insert("tfs_z".to_string(), json!(v));
            }
            if let Some(v) = request.typical_p {
                options.insert("typical_p".to_string(), json!(v));
            }
            if let Some(v) = request.mirostat {
                options.insert("mirostat".to_string(), json!(v));
            }
            if let Some(v) = request.mirostat_tau {
                options.insert("mirostat_tau".to_string(), json!(v));
            }
            if let Some(v) = request.mirostat_eta {
                options.insert("mirostat_eta".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_last_n {
                options.insert("repeat_last_n".to_string(), json!(v));
            }
            if let Some(v) = request.penalize_nl {
                options.insert("penalize_newline".to_string(), json!(v));
            }
            if let Some(v) = request.num_ctx {
                options.insert("num_ctx".to_string(), json!(v));
            }
            if !options.is_empty() {
                obj.insert("options".to_string(), Value::Object(options));
            }
            if let Some(ref v) = request.stop {
                obj.insert("stop".to_string(), json!(v));
            }
        }

        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&body);
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error("ollama", &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error("ollama", base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "ollama native chat request failed ({}): {}",
                status, text
            )));
        }

        let payload: Value = response.json().await.map_err(ApiError::internal)?;
        let message = payload.get("message").unwrap_or(&Value::Null);
        let text = extract_field_text(message, &["content", "text"]);
        let reasoning = extract_field_text(message, &["thinking", "reasoning", "reasoning_content"]);
        Ok(compose_reasoned_content(&reasoning, &text))
    }

    async fn stream_chat_ollama_native(
        &self,
        base_url: &str,
        model_name: &str,
        request: ChatRequest,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let endpoint = format!("{}/api/chat", base_url.trim_end_matches('/'));
        let mut body = json!({
            "model": model_name,
            "messages": request.messages,
            "stream": true,
            "think": true,
        });
        if let Some(obj) = body.as_object_mut() {
            let mut options = serde_json::Map::new();
            if let Some(v) = request.temperature {
                options.insert("temperature".to_string(), json!(v));
            }
            if let Some(v) = request.top_p {
                options.insert("top_p".to_string(), json!(v));
            }
            if let Some(v) = request.top_k {
                options.insert("top_k".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_penalty {
                options.insert("repeat_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.max_tokens {
                options.insert("num_predict".to_string(), json!(v));
            }
            // Common parameters
            if let Some(v) = request.seed {
                options.insert("seed".to_string(), json!(v));
            }
            if let Some(v) = request.frequency_penalty {
                options.insert("frequency_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.presence_penalty {
                options.insert("presence_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.min_p {
                options.insert("min_p".to_string(), json!(v));
            }
            // Ollama-specific sampling parameters
            if let Some(v) = request.tfs_z {
                options.insert("tfs_z".to_string(), json!(v));
            }
            if let Some(v) = request.typical_p {
                options.insert("typical_p".to_string(), json!(v));
            }
            if let Some(v) = request.mirostat {
                options.insert("mirostat".to_string(), json!(v));
            }
            if let Some(v) = request.mirostat_tau {
                options.insert("mirostat_tau".to_string(), json!(v));
            }
            if let Some(v) = request.mirostat_eta {
                options.insert("mirostat_eta".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_last_n {
                options.insert("repeat_last_n".to_string(), json!(v));
            }
            if let Some(v) = request.penalize_nl {
                options.insert("penalize_newline".to_string(), json!(v));
            }
            if let Some(v) = request.num_ctx {
                options.insert("num_ctx".to_string(), json!(v));
            }
            if !options.is_empty() {
                obj.insert("options".to_string(), Value::Object(options));
            }
            if let Some(ref v) = request.stop {
                obj.insert("stop".to_string(), json!(v));
            }
        }

        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&body);
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error("ollama", &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error("ollama", base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "ollama native streaming request failed ({}): {}",
                status, text
            )));
        }

        let (tx, rx) = mpsc::channel(128);
        let mut byte_stream = response.bytes_stream();
        let stream_idle_timeout = self.get_external_loader_stream_idle_timeout();
        tokio::spawn(async move {
            let mut buffer = String::new();
            let mut is_reasoning_open = false;
            loop {
                let next = tokio::time::timeout(stream_idle_timeout, byte_stream.next()).await;
                let next = match next {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = tx
                            .send(Err(ApiError::Internal(format!(
                                "ollama stream idle timeout after {} ms",
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

                            let parsed = match serde_json::from_str::<Value>(&line) {
                                Ok(value) => value,
                                Err(err) => {
                                    let _ = tx
                                        .send(Err(ApiError::Internal(format!(
                                            "Invalid Ollama streaming payload: {}",
                                            err
                                        ))))
                                        .await;
                                    return;
                                }
                            };

                            if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                                let _ = tx.send(Err(ApiError::Internal(err.to_string()))).await;
                                return;
                            }

                            let message = parsed.get("message").unwrap_or(&Value::Null);
                            let mut chunk_to_send = String::new();

                            let reasoning = extract_field_text(
                                message,
                                &["thinking", "reasoning", "reasoning_content"],
                            );
                            if !reasoning.is_empty() {
                                if !is_reasoning_open {
                                    chunk_to_send.push_str("<think>\n");
                                    is_reasoning_open = true;
                                }
                                chunk_to_send.push_str(&reasoning);
                            }

                            let content = extract_field_text(message, &["content", "text"]);
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

                            if parsed.get("done").and_then(|v| v.as_bool()) == Some(true) {
                                if is_reasoning_open {
                                    let _ = tx.send(Ok("\n</think>\n".to_string())).await;
                                }
                                return;
                            }
                        }
                    }
                    Err(err) => {
                        let _ = tx
                            .send(Err(ApiError::Internal(format!(
                                "Ollama streaming transport failed: {}",
                                err
                            ))))
                            .await;
                        return;
                    }
                }
            }

            let trailing = buffer.trim();
            if !trailing.is_empty() {
                if let Ok(parsed) = serde_json::from_str::<Value>(trailing) {
                    let message = parsed.get("message").unwrap_or(&Value::Null);
                    let mut chunk_to_send = String::new();

                    let reasoning =
                        extract_field_text(message, &["thinking", "reasoning", "reasoning_content"]);
                    if !reasoning.is_empty() {
                        if !is_reasoning_open {
                            chunk_to_send.push_str("<think>\n");
                            is_reasoning_open = true;
                        }
                        chunk_to_send.push_str(&reasoning);
                    }

                    let content = extract_field_text(message, &["content", "text"]);
                    if !content.is_empty() {
                        if is_reasoning_open {
                            chunk_to_send.push_str("\n</think>\n");
                            is_reasoning_open = false;
                        }
                        chunk_to_send.push_str(&content);
                    }

                    if !chunk_to_send.is_empty() {
                        let _ = tx.send(Ok(chunk_to_send)).await;
                    }
                }
            }

            if is_reasoning_open {
                let _ = tx.send(Ok("\n</think>\n".to_string())).await;
            }
        });

        Ok(rx)
    }

    async fn chat_lmstudio_native(
        &self,
        base_url: &str,
        model_name: &str,
        request: ChatRequest,
    ) -> Result<String, ApiError> {
        let endpoint = format!("{}/api/v1/chat", base_url.trim_end_matches('/'));

        // Convert ChatMessage to LM Studio v1 input format
        // System prompt is extracted separately; user/assistant messages go into "input"
        let mut system_prompt: Option<String> = None;
        let mut input_items: Vec<Value> = Vec::new();
        for msg in &request.messages {
            if msg.role == "system" {
                system_prompt = Some(msg.content.clone());
            } else {
                input_items.push(json!({
                    "type": "message",
                    "role": msg.role,
                    "content": msg.content
                }));
            }
        }

        let mut body = json!({
            "model": model_name,
            "input": input_items,
            "stream": false,
        });

        if let Some(obj) = body.as_object_mut() {
            if let Some(ref sp) = system_prompt {
                obj.insert("system_prompt".to_string(), json!(sp));
            }
            if let Some(v) = request.temperature {
                obj.insert("temperature".to_string(), json!(v));
            }
            if let Some(v) = request.top_p {
                obj.insert("top_p".to_string(), json!(v));
            }
            if let Some(v) = request.top_k {
                obj.insert("top_k".to_string(), json!(v));
            }
            if let Some(v) = request.min_p {
                obj.insert("min_p".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_penalty {
                obj.insert("repeat_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.max_tokens {
                obj.insert("max_output_tokens".to_string(), json!(v));
            }
            if let Some(v) = request.seed {
                obj.insert("seed".to_string(), json!(v));
            }
        }

        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&body);
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error("lmstudio", &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error("lmstudio", base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "lmstudio native chat request failed ({}): {}",
                status, text
            )));
        }

        // LM Studio v1 response: { "output": [ { "type": "reasoning", "content": "..." }, { "type": "message", "content": "..." } ] }
        let payload: Value = response.json().await.map_err(ApiError::internal)?;
        let mut reasoning_text = String::new();
        let mut message_text = String::new();

        if let Some(outputs) = payload.get("output").and_then(|v| v.as_array()) {
            for item in outputs {
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let content = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
                match item_type {
                    "reasoning" => reasoning_text.push_str(content),
                    "message" => message_text.push_str(content),
                    _ => {} // tool_call, invalid_tool_call etc. - skip
                }
            }
        }

        Ok(compose_reasoned_content(&reasoning_text, &message_text))
    }

    async fn stream_chat_lmstudio_native(
        &self,
        base_url: &str,
        model_name: &str,
        request: ChatRequest,
    ) -> Result<mpsc::Receiver<Result<String, ApiError>>, ApiError> {
        let endpoint = format!("{}/api/v1/chat", base_url.trim_end_matches('/'));

        // Convert ChatMessage to LM Studio v1 input format
        let mut system_prompt: Option<String> = None;
        let mut input_items: Vec<Value> = Vec::new();
        for msg in &request.messages {
            if msg.role == "system" {
                system_prompt = Some(msg.content.clone());
            } else {
                input_items.push(json!({
                    "type": "message",
                    "role": msg.role,
                    "content": msg.content
                }));
            }
        }

        let mut body = json!({
            "model": model_name,
            "input": input_items,
            "stream": true,
        });

        if let Some(obj) = body.as_object_mut() {
            if let Some(ref sp) = system_prompt {
                obj.insert("system_prompt".to_string(), json!(sp));
            }
            if let Some(v) = request.temperature {
                obj.insert("temperature".to_string(), json!(v));
            }
            if let Some(v) = request.top_p {
                obj.insert("top_p".to_string(), json!(v));
            }
            if let Some(v) = request.top_k {
                obj.insert("top_k".to_string(), json!(v));
            }
            if let Some(v) = request.min_p {
                obj.insert("min_p".to_string(), json!(v));
            }
            if let Some(v) = request.repeat_penalty {
                obj.insert("repeat_penalty".to_string(), json!(v));
            }
            if let Some(v) = request.max_tokens {
                obj.insert("max_output_tokens".to_string(), json!(v));
            }
            if let Some(v) = request.seed {
                obj.insert("seed".to_string(), json!(v));
            }
        }

        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&body);
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error("lmstudio", &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error("lmstudio", base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "lmstudio native streaming request failed ({}): {}",
                status, text
            )));
        }

        let (tx, rx) = mpsc::channel(128);
        let mut byte_stream = response.bytes_stream();
        let stream_idle_timeout = self.get_external_loader_stream_idle_timeout();
        tokio::spawn(async move {
            let mut buffer = String::new();
            let mut is_reasoning_open = false;
            // LM Studio v1 SSE format: "event: <type>\ndata: <json>\n\n"
            loop {
                let next = tokio::time::timeout(stream_idle_timeout, byte_stream.next()).await;
                let next = match next {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = tx
                            .send(Err(ApiError::Internal(format!(
                                "lmstudio stream idle timeout after {} ms",
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

                        // Parse SSE events: "event: <type>\ndata: <json>\n\n"
                        while let Some(double_newline) = buffer.find("\n\n") {
                            let event_block = buffer[..double_newline].to_string();
                            buffer = buffer[(double_newline + 2)..].to_string();

                            let mut event_type = String::new();
                            let mut event_data = String::new();
                            for line in event_block.lines() {
                                if let Some(t) = line.strip_prefix("event: ") {
                                    event_type = t.trim().to_string();
                                } else if let Some(d) = line.strip_prefix("data: ") {
                                    event_data = d.trim().to_string();
                                }
                            }

                            match event_type.as_str() {
                                "reasoning.start" => {
                                    if !is_reasoning_open {
                                        let _ = tx.send(Ok("<think>\n".to_string())).await;
                                        is_reasoning_open = true;
                                    }
                                }
                                "reasoning.delta" => {
                                    if let Ok(parsed) = serde_json::from_str::<Value>(&event_data) {
                                        let content = parsed.get("content").and_then(|v| v.as_str()).unwrap_or("");
                                        if !content.is_empty() {
                                            if tx.send(Ok(content.to_string())).await.is_err() {
                                                return;
                                            }
                                        }
                                    }
                                }
                                "reasoning.end" => {
                                    if is_reasoning_open {
                                        let _ = tx.send(Ok("\n</think>\n".to_string())).await;
                                        is_reasoning_open = false;
                                    }
                                }
                                "message.delta" => {
                                    if let Ok(parsed) = serde_json::from_str::<Value>(&event_data) {
                                        let content = parsed.get("content").and_then(|v| v.as_str()).unwrap_or("");
                                        if !content.is_empty() {
                                            if tx.send(Ok(content.to_string())).await.is_err() {
                                                return;
                                            }
                                        }
                                    }
                                }
                                "chat.end" => {
                                    if is_reasoning_open {
                                        let _ = tx.send(Ok("\n</think>\n".to_string())).await;
                                    }
                                    return;
                                }
                                "error" => {
                                    if let Ok(parsed) = serde_json::from_str::<Value>(&event_data) {
                                        let err_msg = parsed
                                            .get("error")
                                            .and_then(|e| e.get("message"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Unknown LM Studio error");
                                        let _ = tx.send(Err(ApiError::Internal(
                                            format!("LM Studio error: {}", err_msg)
                                        ))).await;
                                        return;
                                    }
                                }
                                _ => {
                                    // chat.start, model_load.*, prompt_processing.*, message.start, message.end, tool_call.* - skip
                                }
                            }
                        }
                    }
                    Err(err) => {
                        let _ = tx
                            .send(Err(ApiError::Internal(format!(
                                "LM Studio streaming transport failed: {}",
                                err
                            ))))
                            .await;
                        return;
                    }
                }
            }

            if is_reasoning_open {
                let _ = tx.send(Ok("\n</think>\n".to_string())).await;
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

    async fn get_logprobs_openai_compatible(
        &self,
        loader: &str,
        base_url: &str,
        model_name: &str,
        text: &str,
    ) -> Result<Vec<(String, f64)>, ApiError> {
        let endpoint = format!("{}/v1/completions", base_url.trim_end_matches('/'));
        let body = json!({
            "model": model_name,
            "prompt": text,
            "max_tokens": 1,
            "logprobs": 1,
            "echo": true,
        });

        let request_timeout = self.get_external_loader_request_timeout();
        let response = self.http.post(&endpoint).json(&body);
        let response = tokio::time::timeout(request_timeout, response.send())
            .await
            .map_err(|_| loader_timeout_error(loader, &endpoint, request_timeout, "request"))?
            .map_err(|err| unreachable_loader_error(loader, base_url, err))?;

        if !response.status().is_success() {
            let status = response.status();
            let err_text = response.text().await.unwrap_or_default();
            return Err(ApiError::Internal(format!(
                "{} logprobs request failed ({}): {}",
                loader, status, err_text
            )));
        }

        let payload: Value = response.json().await.map_err(ApiError::internal)?;

        let mut result = Vec::new();

        if let Some(choices) = payload.get("choices").and_then(|v| v.as_array()) {
            if let Some(first_choice) = choices.first() {
                if let Some(logprobs) = first_choice.get("logprobs") {
                    let tokens = logprobs.get("tokens").and_then(|v| v.as_array());
                    let token_logprobs = logprobs.get("token_logprobs").and_then(|v| v.as_array());

                    if let (Some(ts), Some(lps)) = (tokens, token_logprobs) {
                        for (token_val, logprob_val) in ts.iter().zip(lps.iter()) {
                            let token_str = token_val.as_str().unwrap_or("").to_string();
                            let logprob_f64 = logprob_val.as_f64().unwrap_or(0.0);
                            result.push((token_str, logprob_f64));
                        }
                    }
                }
            }
        }

        if result.is_empty() {
            return Err(ApiError::Internal(format!(
                "{} did not return valid logprobs in the response.",
                loader
            )));
        }

        Ok(result)
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

    #[test]
    fn extract_field_text_supports_reasoning_aliases() {
        let payload = json!({
            "reasoning": [{"text": "step-1"}, {"text": "step-2"}],
            "content": "final"
        });
        assert_eq!(
            extract_field_text(&payload, &["reasoning", "reasoning_content", "thinking"]),
            "step-1step-2"
        );
        assert_eq!(extract_field_text(&payload, &["content"]), "final");
    }

    #[test]
    fn compose_reasoned_content_wraps_think_block() {
        assert_eq!(
            compose_reasoned_content("chain", "answer"),
            "<think>\nchain\n</think>\nanswer"
        );
        assert_eq!(
            compose_reasoned_content("chain", ""),
            "<think>\nchain\n</think>"
        );
        assert_eq!(compose_reasoned_content("", "answer"), "answer");
    }
}
