use std::fs;
use std::path::PathBuf;

use reqwest::Client;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;

use super::metadata::{
    determine_ollama_role, extract_architecture_from_model_info, extract_context_length,
    has_embedding_name_hint, infer_role_from_gguf_metadata, parse_ollama_parameters,
    read_gguf_metadata,
};
use super::types::{
    LmStudioV1Response, ModelCapabilities, ModelEntry, OllamaShowResponse, OllamaTagsResponse,
};

#[derive(Debug, Clone)]
pub(crate) struct DiscoveredModel {
    pub id: String,
    pub display_name: String,
    pub role: String,
    pub file_size: u64,
    pub filename: String,
    pub source: String,
    pub file_path: String,
    pub loader: String,
    pub loader_model_name: Option<String>,
    pub sha256: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub context_length: Option<u64>,
    pub architecture: Option<String>,
    pub chat_template: Option<String>,
    pub stop_tokens: Option<Vec<String>>,
    pub default_temperature: Option<f32>,
    pub capabilities: Option<ModelCapabilities>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub format: Option<String>,
    pub tokenizer_path: Option<String>,
    pub tokenizer_format: Option<String>,
}

impl DiscoveredModel {
    pub(crate) fn into_model_entry(self, added_at: String) -> ModelEntry {
        ModelEntry {
            id: self.id,
            display_name: self.display_name,
            role: self.role,
            file_size: self.file_size,
            filename: self.filename,
            source: self.source,
            file_path: self.file_path,
            loader: self.loader,
            loader_model_name: self.loader_model_name,
            repo_id: None,
            revision: None,
            sha256: self.sha256,
            added_at,
            parameter_size: self.parameter_size,
            quantization: self.quantization,
            context_length: self.context_length,
            architecture: self.architecture,
            chat_template: self.chat_template,
            stop_tokens: self.stop_tokens,
            default_temperature: self.default_temperature,
            capabilities: self.capabilities,
            publisher: self.publisher,
            description: self.description,
            format: self.format,
            tokenizer_path: self.tokenizer_path,
            tokenizer_format: self.tokenizer_format,
        }
    }
}

#[async_trait::async_trait]
trait InferenceDiscoveryLayer: Send + Sync {
    async fn discover(&self) -> Result<Vec<DiscoveredModel>, ApiError>;
}

#[derive(Clone)]
struct OllamaDiscoveryLayer {
    client: Client,
    base_url: String,
}

#[derive(Clone)]
struct LmStudioDiscoveryLayer {
    client: Client,
    base_url: String,
}

#[derive(Clone)]
struct LlamaCppDiscoveryLayer {
    models: Vec<ModelEntry>,
}

#[async_trait::async_trait]
impl InferenceDiscoveryLayer for OllamaDiscoveryLayer {
    async fn discover(&self) -> Result<Vec<DiscoveredModel>, ApiError> {
        let res = self
            .client
            .get(format!("{}/api/tags", self.base_url))
            .send()
            .await;
        let Ok(response) = res else {
            return Ok(Vec::new());
        };
        if !response.status().is_success() {
            return Ok(Vec::new());
        }

        let tags: OllamaTagsResponse = response.json().await.map_err(ApiError::internal)?;
        
        let mut fetch_tasks = Vec::new();

        for model in tags.models {
            let client = self.client.clone();
            let base_url = self.base_url.clone();
            
            fetch_tasks.push(async move {
                let show = {
                    let res = client
                        .post(format!("{}/api/show", base_url))
                        .json(&serde_json::json!({ "name": model.name }))
                        .send()
                        .await;
                    match res {
                        Ok(r) if r.status().is_success() => r.json::<OllamaShowResponse>().await.ok(),
                        _ => None,
                    }
                };

                let details = show.as_ref().map(|s| &s.details).unwrap_or(&model.details);
                let model_info = show.as_ref().and_then(|s| s.model_info.as_ref());
                let architecture = extract_architecture_from_model_info(model_info);
                let context_length = extract_context_length(model_info, architecture.as_deref());
                let role = determine_ollama_role(
                    &model.name,
                    details,
                    show.as_ref().and_then(|s| s.capabilities.as_deref()),
                    model_info,
                );
                let (stop_tokens, default_temperature) = show
                    .as_ref()
                    .and_then(|s| s.parameters.as_deref())
                    .map(parse_ollama_parameters)
                    .unwrap_or_default();
                let capabilities = show.as_ref().and_then(|s| {
                    s.capabilities.as_ref().map(|caps| ModelCapabilities {
                        completion: caps.iter().any(|c| c == "completion"),
                        tool_use: caps.iter().any(|c| c == "tools"),
                        vision: caps.iter().any(|c| c == "vision"),
                    })
                });

                DiscoveredModel {
                    id: format!("ollama-{}", model.name),
                    display_name: format!("{} (Ollama)", model.name),
                    role,
                    file_size: model.size,
                    filename: model.name.clone(),
                    source: "ollama".to_string(),
                    file_path: format!("ollama://{}", model.name),
                    loader: "ollama".to_string(),
                    loader_model_name: Some(model.name.clone()),
                    sha256: Some(model.digest),
                    parameter_size: details.parameter_size.clone(),
                    quantization: details.quantization_level.clone(),
                    context_length,
                    architecture,
                    chat_template: show.as_ref().and_then(|s| s.template.clone()),
                    stop_tokens,
                    default_temperature,
                    capabilities,
                    publisher: None,
                    description: None,
                    format: details.format.clone(),
                    tokenizer_path: None,
                    tokenizer_format: None,
                }
            });
        }

        let discovered = futures_util::future::join_all(fetch_tasks).await;
        Ok(discovered)
    }
}

#[async_trait::async_trait]
impl InferenceDiscoveryLayer for LmStudioDiscoveryLayer {
    async fn discover(&self) -> Result<Vec<DiscoveredModel>, ApiError> {
        let res = self
            .client
            .get(format!("{}/api/v1/models", self.base_url))
            .send()
            .await;

        let Ok(response) = res else {
            return Ok(Vec::new());
        };
        if !response.status().is_success() {
            return Ok(Vec::new());
        }

        let body: LmStudioV1Response = response.json().await.map_err(ApiError::internal)?;
        let mut discovered = Vec::new();

        for model in body.models {
            let model_name = model
                .display_name
                .as_deref()
                .unwrap_or(&model.key)
                .to_string();
            let explicit_embedding = model.model_type.eq_ignore_ascii_case("embedding");
            let role = if explicit_embedding || has_embedding_name_hint(&model.key) {
                "embedding".to_string()
            } else {
                "text".to_string()
            };
            let quantization = model.quantization.as_ref().and_then(|q| q.name.clone());
            let capabilities = model.capabilities.as_ref().map(|c| ModelCapabilities {
                completion: role == "text",
                tool_use: c.trained_for_tool_use,
                vision: c.vision,
            });

            discovered.push(DiscoveredModel {
                id: format!("lmstudio-{}", model.key),
                display_name: format!("{} (LM Studio)", model_name),
                role,
                file_size: model.size_bytes.unwrap_or(0),
                filename: model.key.clone(),
                source: "lmstudio".to_string(),
                file_path: format!("lmstudio://{}", model.key),
                loader: "lmstudio".to_string(),
                loader_model_name: Some(model.key.clone()),
                sha256: None,
                parameter_size: model.params_string,
                quantization,
                context_length: model.max_context_length,
                architecture: model.architecture,
                chat_template: None,
                stop_tokens: None,
                default_temperature: None,
                capabilities,
                publisher: model.publisher,
                description: model.description,
                format: model.format,
                tokenizer_path: None,
                tokenizer_format: None,
            });
        }

        Ok(discovered)
    }
}

#[async_trait::async_trait]
impl InferenceDiscoveryLayer for LlamaCppDiscoveryLayer {
    async fn discover(&self) -> Result<Vec<DiscoveredModel>, ApiError> {
        let mut discovered = Vec::new();

        for model in &self.models {
            let is_local_loader = model.loader == "llama_cpp"
                || model.source == "local"
                || model.file_path.ends_with(".gguf");
            if !is_local_loader {
                continue;
            }

            let path = PathBuf::from(&model.file_path);
            let mut role = model.role.clone();
            let mut context_length = model.context_length;
            let mut architecture = model.architecture.clone();
            let mut format = model.format.clone().or_else(|| Some("gguf".to_string()));

            if path.exists() && path.extension().and_then(|e| e.to_str()) == Some("gguf") {
                if let Ok(model_info) = read_gguf_metadata(&path) {
                    if let Some(inferred) =
                        infer_role_from_gguf_metadata(&model.filename, &model_info)
                    {
                        role = inferred;
                    }
                    architecture = extract_architecture_from_model_info(Some(&model_info));
                    context_length =
                        extract_context_length(Some(&model_info), architecture.as_deref());
                    format = Some("gguf".to_string());
                }
            }

            let file_size = fs::metadata(&path)
                .map(|m| m.len())
                .unwrap_or(model.file_size);
            discovered.push(DiscoveredModel {
                id: model.id.clone(),
                display_name: model.display_name.clone(),
                role,
                file_size,
                filename: model.filename.clone(),
                source: model.source.clone(),
                file_path: model.file_path.clone(),
                loader: model.loader.clone(),
                loader_model_name: model.loader_model_name.clone(),
                sha256: model.sha256.clone(),
                parameter_size: model.parameter_size.clone(),
                quantization: model.quantization.clone(),
                context_length,
                architecture,
                tokenizer_path: model.tokenizer_path.clone(),
                tokenizer_format: model.tokenizer_format.clone(),
                chat_template: model.chat_template.clone(),
                stop_tokens: model.stop_tokens.clone(),
                default_temperature: model.default_temperature,
                capabilities: model.capabilities.clone(),
                publisher: model.publisher.clone(),
                description: model.description.clone(),
                format,
            });
        }

        Ok(discovered)
    }
}

pub(crate) async fn refresh_ollama_models(
    config: &ConfigService,
) -> Result<Vec<DiscoveredModel>, ApiError> {
    let layer = OllamaDiscoveryLayer {
        client: Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(ApiError::internal)?,
        base_url: get_loader_url(config, "ollama", "http://localhost:11434"),
    };
    layer.discover().await
}

pub(crate) async fn refresh_lmstudio_models(
    config: &ConfigService,
) -> Result<Vec<DiscoveredModel>, ApiError> {
    let layer = LmStudioDiscoveryLayer {
        client: Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(ApiError::internal)?,
        base_url: get_loader_url(config, "lmstudio", "http://localhost:1234"),
    };
    layer.discover().await
}

pub(crate) async fn refresh_llama_cpp_models(
    models: Vec<ModelEntry>,
) -> Result<Vec<DiscoveredModel>, ApiError> {
    let layer = LlamaCppDiscoveryLayer { models };
    layer.discover().await
}

fn get_loader_url(config: &ConfigService, loader: &str, default: &str) -> String {
    if let Ok(config) = config.load_config() {
        if let Some(loaders) = config.get("loaders") {
            if let Some(loader_config) = loaders.get(loader) {
                if let Some(url) = loader_config.get("base_url").and_then(|v| v.as_str()) {
                    return url.trim_end_matches('/').to_string();
                }
            }
        }
    }
    default.to_string()
}
