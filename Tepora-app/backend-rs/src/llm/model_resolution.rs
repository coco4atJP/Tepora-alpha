use std::path::PathBuf;

use serde_json::Value;

#[cfg(test)]
use serde_json::json;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::llm::types::ChatRequest;
use crate::models::types::{ModelEntry, ModelRuntimeConfig};
use crate::models::ModelManager;

#[derive(Debug)]
pub(crate) enum ModelExecutionTarget {
    LlamaCpp(ModelRuntimeConfig),
    OpenAiCompatible {
        loader: String,
        base_url: String,
        model_name: String,
    },
}

pub(crate) fn resolve_model_target(
    models: &ModelManager,
    config_service: &ConfigService,
    model_id: &str,
    request: &ChatRequest,
) -> Result<ModelExecutionTarget, ApiError> {
    let model_entry = models
        .get_model(model_id)?
        .ok_or_else(|| ApiError::BadRequest(format!("Model not found: {}", model_id)))?;
    let config = config_service.load_config().unwrap_or(Value::Null);
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
            let base_url = loader_base_url(&config, "ollama", "http://localhost:11434");
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
            let base_url = loader_base_url(&config, "lmstudio", "http://localhost:1234");
            Ok(ModelExecutionTarget::OpenAiCompatible {
                loader,
                base_url,
                model_name,
            })
        }
        "llama_cpp" => {
            let model_config = resolve_llama_model_config(&model_entry, &config, request)?;
            Ok(ModelExecutionTarget::LlamaCpp(model_config))
        }
        other => Err(ApiError::BadRequest(format!(
            "Model '{}' has unsupported loader '{}'. Supported loaders are: llama_cpp, ollama, lmstudio",
            model_id, other
        ))),
    }
}

fn resolve_llama_model_config(
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

fn loader_base_url(config: &Value, loader: &str, default_url: &str) -> String {
    config
        .get("loaders")
        .and_then(|v| v.get(loader))
        .and_then(|v| v.get("base_url"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
        .unwrap_or_else(|| default_url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            tokenizer_path: None,
            tokenizer_format: None,
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
            loader_base_url(&config, "ollama", "http://localhost:11434"),
            "http://127.0.0.1:11434"
        );
    }

    #[test]
    fn loader_base_url_uses_default_when_missing() {
        let config = json!({});
        assert_eq!(
            loader_base_url(&config, "lmstudio", "http://localhost:1234"),
            "http://localhost:1234"
        );
    }
}
