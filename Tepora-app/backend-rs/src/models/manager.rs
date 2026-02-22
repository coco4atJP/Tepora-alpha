use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;

use super::types::{
    LmStudioV1Response, ModelCapabilities, ModelDownloadPolicy, ModelDownloadResult, ModelEntry,
    ModelRegistry, OllamaModelDetails, OllamaShowResponse, OllamaTagsResponse,
};

#[derive(Clone)]
pub struct ModelManager {
    paths: AppPaths,
    config: ConfigService,
    registry_path: PathBuf,
    client: Client,
}

#[derive(Debug, Clone)]
struct DiscoveredModel {
    id: String,
    display_name: String,
    role: String,
    file_size: u64,
    filename: String,
    source: String,
    file_path: String,
    loader: String,
    loader_model_name: Option<String>,
    sha256: Option<String>,
    parameter_size: Option<String>,
    quantization: Option<String>,
    context_length: Option<u64>,
    architecture: Option<String>,
    chat_template: Option<String>,
    stop_tokens: Option<Vec<String>>,
    default_temperature: Option<f32>,
    capabilities: Option<ModelCapabilities>,
    publisher: Option<String>,
    description: Option<String>,
    format: Option<String>,
}

impl DiscoveredModel {
    fn into_model_entry(self, added_at: String) -> ModelEntry {
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
        }
    }
}

#[async_trait::async_trait]
trait InferenceDiscoveryLayer: Send + Sync {
    fn layer_name(&self) -> &'static str;
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
    fn layer_name(&self) -> &'static str {
        "ollama"
    }

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
        let mut discovered = Vec::new();

        for model in tags.models {
            let show: Option<OllamaShowResponse> = {
                let res = self
                    .client
                    .post(format!("{}/api/show", self.base_url))
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

            discovered.push(DiscoveredModel {
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
            });
        }

        Ok(discovered)
    }
}

#[async_trait::async_trait]
impl InferenceDiscoveryLayer for LmStudioDiscoveryLayer {
    fn layer_name(&self) -> &'static str {
        "lmstudio"
    }

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
            });
        }

        Ok(discovered)
    }
}

#[async_trait::async_trait]
impl InferenceDiscoveryLayer for LlamaCppDiscoveryLayer {
    fn layer_name(&self) -> &'static str {
        "llama_cpp"
    }

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

impl ModelManager {
    pub fn new(paths: &AppPaths, config: ConfigService) -> Self {
        let registry_path = paths.user_data_dir.join("models.json");
        Self {
            paths: paths.clone(),
            config,
            registry_path,
            client: Client::new(),
        }
    }

    pub fn list_models(&self) -> Result<Vec<ModelEntry>, ApiError> {
        let registry = self.load_registry()?;
        Ok(registry.models)
    }

    pub fn get_registry(&self) -> Result<ModelRegistry, ApiError> {
        self.load_registry()
    }

    pub fn save_registry(&self, registry: &ModelRegistry) -> Result<(), ApiError> {
        let data = serde_json::to_string_pretty(registry).map_err(ApiError::internal)?;
        if let Some(parent) = self.registry_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&self.registry_path, data).map_err(ApiError::internal)?;
        Ok(())
    }

    pub fn get_model(&self, model_id: &str) -> Result<Option<ModelEntry>, ApiError> {
        let registry = self.load_registry()?;
        Ok(registry.models.into_iter().find(|m| m.id == model_id))
    }

    pub fn register_local_model(
        &self,
        file_path: &Path,
        role: &str,
        display_name: &str,
    ) -> Result<ModelEntry, ApiError> {
        if !file_path.exists() {
            return Err(ApiError::BadRequest("File not found".to_string()));
        }
        if file_path
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.to_lowercase())
            != Some("gguf".to_string())
        {
            return Err(ApiError::BadRequest(
                "Only .gguf files are supported".to_string(),
            ));
        }

        let metadata = fs::metadata(file_path).map_err(ApiError::internal)?;
        let filename = file_path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_string();
        let gguf_model_info = read_gguf_metadata(file_path).ok();
        let inferred_role = gguf_model_info
            .as_ref()
            .and_then(|info| infer_role_from_gguf_metadata(&filename, info))
            .unwrap_or_else(|| role.to_string());
        let architecture = extract_architecture_from_model_info(gguf_model_info.as_ref());
        let context_length =
            extract_context_length(gguf_model_info.as_ref(), architecture.as_deref());
        let model_id = format!(
            "{}-{}",
            inferred_role.to_lowercase(),
            file_path
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("model")
        );

        let entry = ModelEntry {
            id: unique_model_id(&model_id, &self.load_registry()?.models),
            display_name: display_name.to_string(),
            role: inferred_role,
            file_size: metadata.len(),
            filename,
            source: "local".to_string(),
            file_path: file_path.to_string_lossy().to_string(),
            repo_id: None,
            revision: None,
            sha256: None,
            added_at: Utc::now().to_rfc3339(),
            loader: "llama_cpp".to_string(),
            loader_model_name: None,
            parameter_size: None,
            quantization: None,
            context_length,
            architecture,
            chat_template: None,
            stop_tokens: None,
            default_temperature: None,
            capabilities: None,
            publisher: None,
            description: None,
            format: Some("gguf".to_string()),
        };

        let mut registry = self.load_registry()?;
        registry.models.push(entry.clone());
        self.save_registry(&registry)?;
        Ok(entry)
    }

    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    pub async fn download_from_huggingface(
        &self,
        repo_id: &str,
        filename: &str,
        role: &str,
        display_name: &str,
        revision: Option<&str>,
        expected_sha256: Option<&str>,
        consent_provided: bool,
        progress_cb: Option<&(dyn Fn(f32, &str) + Sync)>,
    ) -> Result<ModelDownloadResult, ApiError> {
        let policy = self.evaluate_download_policy(repo_id, filename, revision, expected_sha256);
        if !policy.allowed {
            return Ok(ModelDownloadResult {
                success: false,
                requires_consent: false,
                warnings: policy.warnings,
                path: None,
                error_message: Some("Download blocked by policy requirements".to_string()),
                model_id: None,
            });
        }
        if policy.requires_consent && !consent_provided {
            return Ok(ModelDownloadResult {
                success: false,
                requires_consent: true,
                warnings: policy.warnings,
                path: None,
                error_message: None,
                model_id: None,
            });
        }

        let target_path = self.model_storage_path(role, filename)?;
        if let Some(parent) = target_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let url = hf_resolve_url(repo_id, filename, revision);
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(ApiError::internal)?
            .error_for_status()
            .map_err(ApiError::internal)?;

        let total = response.content_length().unwrap_or(0);
        let mut stream = response.bytes_stream();

        let mut file = fs::File::create(&target_path).map_err(ApiError::internal)?;
        let mut downloaded: u64 = 0;
        let mut hasher = Sha256::new();

        while let Some(chunk) = stream.next().await {
            let data = chunk.map_err(ApiError::internal)?;
            file.write_all(&data).map_err(ApiError::internal)?;
            hasher.update(&data);
            downloaded += data.len() as u64;
            if let Some(cb) = progress_cb {
                let progress = if total > 0 {
                    downloaded as f32 / total as f32
                } else {
                    0.0
                };
                cb(progress, "Downloading model...");
            }
        }

        let file_size = fs::metadata(&target_path)
            .map_err(ApiError::internal)?
            .len();
        let actual_sha256 = hex::encode(hasher.finalize());
        if let Some(expected_hash) = normalize_sha256(expected_sha256) {
            if actual_sha256 != expected_hash {
                let _ = fs::remove_file(&target_path);
                return Ok(ModelDownloadResult {
                    success: false,
                    requires_consent: false,
                    warnings: vec!["SHA256 verification failed".to_string()],
                    path: None,
                    error_message: Some(
                        "Downloaded file SHA256 did not match expected value".to_string(),
                    ),
                    model_id: None,
                });
            }
        }

        let normalized_revision = revision
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string());
        let sha256 = Some(actual_sha256.clone());
        let entry = self.add_model_entry(
            repo_id,
            filename,
            role,
            display_name,
            &target_path,
            file_size,
            normalized_revision,
            sha256.clone(),
        )?;

        Ok(ModelDownloadResult {
            success: true,
            requires_consent: false,
            warnings: policy.warnings,
            path: Some(target_path),
            error_message: None,
            model_id: Some(entry.id),
        })
    }

    pub fn delete_model(&self, model_id: &str) -> Result<bool, ApiError> {
        let mut registry = self.load_registry()?;
        let before = registry.models.len();
        let mut remove_path: Option<PathBuf> = None;
        registry.models.retain(|model| {
            if model.id == model_id {
                remove_path = Some(PathBuf::from(&model.file_path));
                false
            } else {
                true
            }
        });
        if before == registry.models.len() {
            return Ok(false);
        }

        // Skip file deletion if other entries are still referencing the same file_path
        if let Some(ref path) = remove_path {
            let path_str = path.to_string_lossy();
            let still_referenced = registry
                .models
                .iter()
                .any(|m| m.file_path == path_str.as_ref());
            if !still_referenced && path.starts_with(&self.paths.user_data_dir) {
                let _ = fs::remove_file(path);
            }
        }

        registry
            .role_assignments
            .retain(|_, value| value != model_id);
        for order in registry.role_order.values_mut() {
            order.retain(|id| id != model_id);
        }

        self.save_registry(&registry)?;
        Ok(true)
    }

    #[allow(dead_code)]
    pub async fn get_remote_file_size(
        &self,
        repo_id: &str,
        filename: &str,
    ) -> Result<Option<u64>, ApiError> {
        let url = hf_resolve_url(repo_id, filename, None);
        let response = self
            .client
            .head(url)
            .send()
            .await
            .map_err(ApiError::internal)?;
        let headers = response.headers();
        Ok(content_length(headers))
    }

    pub async fn check_update(
        &self,
        repo_id: &str,
        filename: &str,
        revision: Option<&str>,
        current_sha: Option<&str>,
        current_size: Option<u64>,
    ) -> Result<Value, ApiError> {
        let url = hf_resolve_url(repo_id, filename, revision);
        let response = self
            .client
            .head(url)
            .send()
            .await
            .map_err(ApiError::internal)?;
        let headers = response.headers();
        let remote_size = content_length(headers);
        let remote_etag = headers
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim_matches('"').to_string());

        let mut has_update = false;
        if let (Some(remote), Some(current)) = (remote_etag.as_deref(), current_sha) {
            if remote != current {
                has_update = true;
            }
        } else if let (Some(remote), Some(current)) = (remote_size, current_size) {
            if remote != current {
                has_update = true;
            }
        }

        Ok(serde_json::json!({
            "has_update": has_update,
            "remote_size": remote_size,
            "remote_etag": remote_etag,
        }))
    }

    pub fn set_role_model(&self, role: &str, model_id: &str) -> Result<bool, ApiError> {
        let mut registry = self.load_registry()?;
        let Some(model) = registry.models.iter().find(|m| m.id == model_id) else {
            return Ok(false);
        };

        if let Some(expected_role) = expected_model_role_for_assignment(role) {
            if model.role != expected_role {
                return Err(ApiError::BadRequest(format!(
                    "Model '{}' has role '{}', but assignment '{}' requires '{}'",
                    model_id, model.role, role, expected_role
                )));
            }
        }
        registry
            .role_assignments
            .insert(role.to_string(), model_id.to_string());
        self.save_registry(&registry)?;
        Ok(true)
    }

    pub fn resolve_character_model_id(
        &self,
        active_character_id: Option<&str>,
    ) -> Result<Option<String>, ApiError> {
        let registry = self.load_registry()?;
        Ok(resolve_character_model_id_from_registry(
            &registry,
            active_character_id,
        ))
    }

    pub fn resolve_agent_model_id(
        &self,
        agent_id: Option<&str>,
    ) -> Result<Option<String>, ApiError> {
        let registry = self.load_registry()?;

        if let Some(agent) = normalized_subject_id(agent_id) {
            let key = format!("agent:{}", agent);
            if let Some(model_id) = registry.role_assignments.get(&key) {
                return Ok(Some(model_id.clone()));
            }
        }

        if let Some(model_id) = registry.role_assignments.get("professional") {
            return Ok(Some(model_id.clone()));
        }

        Ok(resolve_character_model_id_from_registry(&registry, None))
    }

    pub fn resolve_embedding_model_id(&self) -> Result<Option<String>, ApiError> {
        let registry = self.load_registry()?;
        if let Some(model_id) = registry.role_assignments.get("embedding") {
            return Ok(Some(model_id.clone()));
        }
        Ok(registry
            .models
            .iter()
            .find(|model| model.role == "embedding")
            .map(|model| model.id.clone()))
    }

    pub fn remove_role_assignment(&self, role: &str) -> Result<bool, ApiError> {
        let mut registry = self.load_registry()?;
        let removed = registry.role_assignments.remove(role).is_some();
        self.save_registry(&registry)?;
        Ok(removed)
    }

    pub fn reorder_models(&self, role: &str, model_ids: Vec<String>) -> Result<bool, ApiError> {
        let mut registry = self.load_registry()?;
        registry.role_order.insert(role.to_string(), model_ids);
        self.save_registry(&registry)?;
        Ok(true)
    }

    pub fn evaluate_download_policy(
        &self,
        repo_id: &str,
        _filename: &str,
        revision: Option<&str>,
        expected_sha256: Option<&str>,
    ) -> ModelDownloadPolicy {
        let config = self.config.load_config().unwrap_or(Value::Null);
        evaluate_download_policy_from_config(&config, repo_id, revision, expected_sha256)
    }

    pub fn update_active_model_config(&self, role: &str, model_id: &str) -> Result<(), ApiError> {
        let registry = self.load_registry()?;
        let Some(model) = registry.models.iter().find(|m| m.id == model_id) else {
            return Err(ApiError::NotFound("Model not found".to_string()));
        };

        let mut config = self.config.load_config()?;
        let config_root = config
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("Invalid root configuration".to_string()))?;
        let models_gguf = config_root
            .entry("models_gguf".to_string())
            .or_insert_with(|| Value::Object(Default::default()))
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("Invalid models_gguf configuration".to_string()))?;

        let key = if role == "embedding" {
            "embedding_model"
        } else {
            "text_model"
        };

        let mut entry = models_gguf
            .get(key)
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let entry_obj = entry
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("Invalid models_gguf configuration".to_string()))?;
        entry_obj.insert("path".to_string(), Value::String(model.file_path.clone()));
        if !entry_obj.contains_key("port") {
            entry_obj.insert(
                "port".to_string(),
                Value::Number(if role == "embedding" { 8090 } else { 8088 }.into()),
            );
        }
        if !entry_obj.contains_key("n_ctx") {
            entry_obj.insert("n_ctx".to_string(), Value::Number(4096.into()));
        }
        if !entry_obj.contains_key("n_gpu_layers") {
            entry_obj.insert("n_gpu_layers".to_string(), Value::Number((-1).into()));
        }

        models_gguf.insert(key.to_string(), entry);
        self.config.update_config(config, false)?;
        Ok(())
    }

    fn model_storage_path(&self, role: &str, filename: &str) -> Result<PathBuf, ApiError> {
        let safe_role = role.to_lowercase();
        let base = self.paths.user_data_dir.join("models").join(safe_role);
        // Sanitize the filename to prevent path traversal
        let safe_filename = sanitize_model_filename(filename)
            .ok_or_else(|| ApiError::BadRequest("Invalid model filename".to_string()))?;
        Ok(base.join(safe_filename))
    }

    /// モデルエントリの追加または更新（upsert）。
    /// `repo_id + filename + role` が一致する既存エントリがあれば更新、なければ新規追加。
    #[allow(clippy::too_many_arguments)]
    fn add_model_entry(
        &self,
        repo_id: &str,
        filename: &str,
        role: &str,
        display_name: &str,
        path: &Path,
        file_size: u64,
        revision: Option<String>,
        sha256: Option<String>,
    ) -> Result<ModelEntry, ApiError> {
        let mut registry = self.load_registry()?;
        let file_path_str = path.to_string_lossy().to_string();
        let gguf_model_info = read_gguf_metadata(path).ok();
        let effective_role = gguf_model_info
            .as_ref()
            .and_then(|info| infer_role_from_gguf_metadata(filename, info))
            .unwrap_or_else(|| role.to_string());
        let architecture = extract_architecture_from_model_info(gguf_model_info.as_ref());
        let context_length =
            extract_context_length(gguf_model_info.as_ref(), architecture.as_deref());

        // C-2 fix: repo_id + filename + role で既存エントリを検索し、あれば更新
        if let Some(existing) = registry.models.iter_mut().find(|m| {
            m.repo_id.as_deref() == Some(repo_id)
                && m.filename == filename
                && m.role == effective_role
        }) {
            existing.display_name = display_name.to_string();
            existing.file_path = file_path_str;
            existing.file_size = file_size;
            existing.role = effective_role.clone();
            existing.architecture = architecture.clone();
            existing.context_length = context_length;
            existing.revision = revision;
            existing.sha256 = sha256;
            existing.added_at = Utc::now().to_rfc3339();
            let updated = existing.clone();
            self.save_registry(&registry)?;
            return Ok(updated);
        }

        // 新規追加
        let base_id = format!("{}-{}", effective_role, filename);
        let id = unique_model_id(&base_id, &registry.models);

        let entry = ModelEntry {
            id: id.clone(),
            display_name: display_name.to_string(),
            role: effective_role,
            file_size,
            filename: filename.to_string(),
            source: repo_id.to_string(),
            file_path: file_path_str,
            repo_id: Some(repo_id.to_string()),
            revision,
            sha256,
            added_at: Utc::now().to_rfc3339(),
            loader: "llama_cpp".to_string(),
            loader_model_name: None,
            parameter_size: None,
            quantization: None,
            context_length,
            architecture,
            chat_template: None,
            stop_tokens: None,
            default_temperature: None,
            capabilities: None,
            publisher: None,
            description: None,
            format: Some("gguf".to_string()),
        };

        registry.models.push(entry.clone());
        self.save_registry(&registry)?;
        Ok(entry)
    }

    pub async fn refresh_all_loader_models(&self) -> Result<usize, ApiError> {
        let mut count = 0;
        count += self.refresh_llama_cpp_models().await?;
        count += self.refresh_ollama_models().await?;
        count += self.refresh_lmstudio_models().await?;
        Ok(count)
    }

    fn get_loader_url(&self, loader: &str, default: &str) -> String {
        if let Ok(config) = self.config.load_config() {
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

    pub async fn refresh_ollama_models(&self) -> Result<usize, ApiError> {
        let layer = OllamaDiscoveryLayer {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(ApiError::internal)?,
            base_url: self.get_loader_url("ollama", "http://localhost:11434"),
        };
        let discovered = layer.discover().await?;
        self.apply_discovered_models(layer.layer_name(), discovered)
    }

    pub async fn refresh_lmstudio_models(&self) -> Result<usize, ApiError> {
        let layer = LmStudioDiscoveryLayer {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(ApiError::internal)?,
            base_url: self.get_loader_url("lmstudio", "http://localhost:1234"),
        };
        let discovered = layer.discover().await?;
        self.apply_discovered_models(layer.layer_name(), discovered)
    }

    pub async fn refresh_llama_cpp_models(&self) -> Result<usize, ApiError> {
        let registry = self.load_registry()?;
        let layer = LlamaCppDiscoveryLayer {
            models: registry.models,
        };
        let discovered = layer.discover().await?;
        self.apply_discovered_models(layer.layer_name(), discovered)
    }

    fn apply_discovered_models(
        &self,
        _layer_name: &str,
        discovered: Vec<DiscoveredModel>,
    ) -> Result<usize, ApiError> {
        if discovered.is_empty() {
            return Ok(0);
        }

        let mut registry = self.load_registry()?;
        let now = Utc::now().to_rfc3339();
        let mut count = 0;

        for discovered_model in discovered {
            if let Some(existing) = registry
                .models
                .iter_mut()
                .find(|m| m.id == discovered_model.id)
            {
                let changed = existing.display_name != discovered_model.display_name
                    || existing.role != discovered_model.role
                    || existing.file_size != discovered_model.file_size
                    || existing.filename != discovered_model.filename
                    || existing.source != discovered_model.source
                    || existing.file_path != discovered_model.file_path
                    || existing.loader != discovered_model.loader
                    || existing.loader_model_name != discovered_model.loader_model_name
                    || existing.sha256 != discovered_model.sha256
                    || existing.parameter_size != discovered_model.parameter_size
                    || existing.quantization != discovered_model.quantization
                    || existing.context_length != discovered_model.context_length
                    || existing.architecture != discovered_model.architecture
                    || existing.chat_template != discovered_model.chat_template
                    || existing.stop_tokens != discovered_model.stop_tokens
                    || existing.default_temperature != discovered_model.default_temperature
                    || existing.capabilities != discovered_model.capabilities
                    || existing.publisher != discovered_model.publisher
                    || existing.description != discovered_model.description
                    || existing.format != discovered_model.format;

                existing.display_name = discovered_model.display_name;
                existing.role = discovered_model.role;
                existing.file_size = discovered_model.file_size;
                existing.filename = discovered_model.filename;
                existing.source = discovered_model.source;
                existing.file_path = discovered_model.file_path;
                existing.loader = discovered_model.loader;
                existing.loader_model_name = discovered_model.loader_model_name;
                existing.sha256 = discovered_model.sha256;
                existing.parameter_size = discovered_model.parameter_size;
                existing.quantization = discovered_model.quantization;
                existing.context_length = discovered_model.context_length;
                existing.architecture = discovered_model.architecture;
                existing.chat_template = discovered_model.chat_template;
                existing.stop_tokens = discovered_model.stop_tokens;
                existing.default_temperature = discovered_model.default_temperature;
                existing.capabilities = discovered_model.capabilities;
                existing.publisher = discovered_model.publisher;
                existing.description = discovered_model.description;
                existing.format = discovered_model.format;

                if changed {
                    count += 1;
                }
                continue;
            }

            registry
                .models
                .push(discovered_model.into_model_entry(now.clone()));
            count += 1;
        }

        if count > 0 {
            self.save_registry(&registry)?;
        }

        Ok(count)
    }

    fn load_registry(&self) -> Result<ModelRegistry, ApiError> {
        if !self.registry_path.exists() {
            return Ok(ModelRegistry::default());
        }
        let contents = fs::read_to_string(&self.registry_path).map_err(ApiError::internal)?;
        if contents.trim().is_empty() {
            return Ok(ModelRegistry::default());
        }
        let mut registry: ModelRegistry =
            serde_json::from_str(&contents).map_err(ApiError::internal)?;
        if migrate_legacy_loader_roles(&mut registry) {
            self.save_registry(&registry)?;
        }
        Ok(registry)
    }
}

/// 過去バージョンで誤分類されたローダーモデルの role を補正する。
/// `embeddinggemma` のようなモデルが `text` で永続化されているケースを自動修復する。
fn migrate_legacy_loader_roles(registry: &mut ModelRegistry) -> bool {
    let mut changed = false;

    for model in &mut registry.models {
        if model.role == "embedding" {
            continue;
        }
        let is_ollama_model = model.loader == "ollama" || model.source == "ollama";
        if !is_ollama_model {
            continue;
        }

        let name = model
            .loader_model_name
            .as_deref()
            .filter(|v| !v.is_empty())
            .unwrap_or(&model.filename);
        let has_name_hint = has_embedding_name_hint(name);
        let has_embedding_like_caps = model
            .capabilities
            .as_ref()
            .map(|caps| !caps.completion && !caps.tool_use && !caps.vision)
            .unwrap_or(false);

        if has_name_hint || has_embedding_like_caps {
            model.role = "embedding".to_string();
            changed = true;
        }
    }

    changed
}

fn normalized_subject_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

fn resolve_character_model_id_from_registry(
    registry: &ModelRegistry,
    active_character_id: Option<&str>,
) -> Option<String> {
    if let Some(character_id) = normalized_subject_id(active_character_id) {
        let key = format!("character:{}", character_id);
        if let Some(model_id) = registry.role_assignments.get(&key) {
            return Some(model_id.clone());
        }
    }

    registry
        .role_assignments
        .get("character")
        .cloned()
        .or_else(|| registry.role_assignments.get("text").cloned())
        .or_else(|| {
            registry
                .models
                .iter()
                .find(|model| model.role == "text")
                .map(|model| model.id.clone())
        })
}

fn expected_model_role_for_assignment(role: &str) -> Option<&'static str> {
    let normalized = role.trim();
    if normalized.is_empty() {
        return None;
    }

    if normalized == "embedding" || normalized.starts_with("embedding:") {
        return Some("embedding");
    }

    if normalized == "text"
        || normalized == "character"
        || normalized.starts_with("character:")
        || normalized == "professional"
        || normalized.starts_with("professional:")
        || normalized.starts_with("agent:")
    {
        return Some("text");
    }

    None
}

fn has_embedding_name_hint(name: &str) -> bool {
    const EMBEDDING_NAME_HINTS: &[&str] =
        &["embedding", "embed", "nomic-embed", "e5", "bge", "gte"];
    let lowered = name.to_ascii_lowercase();
    EMBEDDING_NAME_HINTS
        .iter()
        .any(|hint| lowered.contains(hint))
}

fn extract_architecture_from_model_info(
    model_info: Option<&HashMap<String, Value>>,
) -> Option<String> {
    model_info
        .and_then(|info| info.get("general.architecture"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn infer_role_from_gguf_metadata(
    model_name: &str,
    model_info: &HashMap<String, Value>,
) -> Option<String> {
    if let Some(general_type) = model_info
        .get("general.type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
    {
        if general_type.contains("embedding") || general_type.contains("embed") {
            return Some("embedding".to_string());
        }
        if general_type.contains("text") || general_type.contains("causal") {
            return Some("text".to_string());
        }
    }

    let has_embedding_pooling = model_info.iter().any(|(k, v)| {
        if !k.ends_with(".pooling_type") {
            return false;
        }
        v.as_u64().is_some_and(|n| n > 0)
            || v.as_i64().is_some_and(|n| n > 0)
            || v.as_str()
                .map(|s| {
                    let lowered = s.to_ascii_lowercase();
                    lowered.contains("mean") || lowered.contains("cls") || lowered.contains("last")
                })
                .unwrap_or(false)
    });
    if has_embedding_pooling {
        return Some("embedding".to_string());
    }

    let has_text_decoder_hint = model_info
        .keys()
        .any(|k| k.ends_with(".block_count") || k.contains("attention.head_count"));
    if has_text_decoder_hint {
        return Some("text".to_string());
    }

    if has_embedding_name_hint(model_name) {
        return Some("embedding".to_string());
    }

    None
}

/// Ollamaモデルの情報からroleを推定する。
/// family/families だけでは判定できないケース（例: embeddinggemma）に対応するため、
/// capabilities とモデル名ヒントも併用する。
fn determine_ollama_role(
    model_name: &str,
    details: &OllamaModelDetails,
    capabilities: Option<&[String]>,
    model_info: Option<&HashMap<String, Value>>,
) -> String {
    const EMBEDDING_FAMILIES: &[&str] = &["bert", "nomic-bert", "clip"];
    const EMBEDDING_CAPABILITY_HINTS: &[&str] = &["embedding", "embed"];
    const TEXT_CAPABILITY_HINTS: &[&str] = &["completion", "chat", "generate"];

    if let Some(role) = model_info.and_then(|info| infer_role_from_gguf_metadata(model_name, info))
    {
        return role;
    }

    let family = details.family.as_deref().unwrap_or("").to_ascii_lowercase();
    let families = details.families.as_deref().unwrap_or(&[]);

    let is_embedding_by_family = EMBEDDING_FAMILIES
        .iter()
        .any(|&ef| family == ef || families.iter().any(|f| f.to_ascii_lowercase() == ef));

    if is_embedding_by_family {
        "embedding".to_string()
    } else if capabilities
        .map(|caps| {
            caps.iter().any(|cap| {
                let cap = cap.to_ascii_lowercase();
                EMBEDDING_CAPABILITY_HINTS
                    .iter()
                    .any(|hint| cap.contains(hint))
            })
        })
        .unwrap_or(false)
    {
        "embedding".to_string()
    } else if capabilities
        .map(|caps| {
            caps.iter().any(|cap| {
                let cap = cap.to_ascii_lowercase();
                TEXT_CAPABILITY_HINTS.iter().any(|hint| cap.contains(hint))
            })
        })
        .unwrap_or(false)
    {
        "text".to_string()
    } else if has_embedding_name_hint(model_name) {
        "embedding".to_string()
    } else {
        "text".to_string()
    }
}

fn read_gguf_metadata(path: &Path) -> Result<HashMap<String, Value>, ApiError> {
    let mut file = fs::File::open(path).map_err(ApiError::internal)?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(ApiError::internal)?;
    if &magic != b"GGUF" {
        return Err(ApiError::BadRequest(
            "Invalid GGUF magic header".to_string(),
        ));
    }

    let version = read_u32_le(&mut file)?;
    if !(1..=3).contains(&version) {
        return Err(ApiError::BadRequest(format!(
            "Unsupported GGUF version: {}",
            version
        )));
    }

    // tensor_count (unused)
    let _ = read_gguf_count(&mut file, version)?;
    let kv_count = read_gguf_count(&mut file, version)?;

    let mut model_info = HashMap::new();
    for _ in 0..kv_count {
        let key = read_gguf_string(&mut file, version)?;
        let value_type = read_u32_le(&mut file)?;
        let value = read_gguf_value(&mut file, version, value_type)?;
        model_info.insert(key, value);
    }

    Ok(model_info)
}

fn read_gguf_count<R: Read>(reader: &mut R, version: u32) -> Result<u64, ApiError> {
    if version == 1 {
        Ok(read_u32_le(reader)? as u64)
    } else {
        read_u64_le(reader)
    }
}

fn read_gguf_string<R: Read>(reader: &mut R, version: u32) -> Result<String, ApiError> {
    let len = read_gguf_count(reader, version)?;
    if len > 1_000_000 {
        return Err(ApiError::BadRequest(
            "GGUF string length is too large".to_string(),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    String::from_utf8(buf).map_err(ApiError::internal)
}

fn read_gguf_value<R: Read>(
    reader: &mut R,
    version: u32,
    value_type: u32,
) -> Result<Value, ApiError> {
    match value_type {
        0 => Ok(Value::from(read_u8_le(reader)?)),
        1 => Ok(Value::from(read_i8_le(reader)?)),
        2 => Ok(Value::from(read_u16_le(reader)?)),
        3 => Ok(Value::from(read_i16_le(reader)?)),
        4 => Ok(Value::from(read_u32_le(reader)?)),
        5 => Ok(Value::from(read_i32_le(reader)?)),
        6 => Ok(serde_json::Number::from_f64(read_f32_le(reader)? as f64)
            .map(Value::Number)
            .unwrap_or(Value::Null)),
        7 => Ok(Value::Bool(read_u8_le(reader)? != 0)),
        8 => Ok(Value::String(read_gguf_string(reader, version)?)),
        9 => {
            let array_type = read_u32_le(reader)?;
            let len = read_gguf_count(reader, version)?;
            if len > 100_000 {
                return Err(ApiError::BadRequest(
                    "GGUF array length is too large".to_string(),
                ));
            }
            let mut values = Vec::with_capacity(len as usize);
            for _ in 0..len {
                values.push(read_gguf_value(reader, version, array_type)?);
            }
            Ok(Value::Array(values))
        }
        10 => Ok(Value::from(read_u64_le(reader)?)),
        11 => Ok(Value::from(read_i64_le(reader)?)),
        12 => Ok(serde_json::Number::from_f64(read_f64_le(reader)?)
            .map(Value::Number)
            .unwrap_or(Value::Null)),
        other => Err(ApiError::BadRequest(format!(
            "Unsupported GGUF value type: {}",
            other
        ))),
    }
}

fn read_u8_le<R: Read>(reader: &mut R) -> Result<u8, ApiError> {
    let mut buf = [0u8; 1];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(buf[0])
}

fn read_i8_le<R: Read>(reader: &mut R) -> Result<i8, ApiError> {
    Ok(read_u8_le(reader)? as i8)
}

fn read_u16_le<R: Read>(reader: &mut R) -> Result<u16, ApiError> {
    let mut buf = [0u8; 2];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(u16::from_le_bytes(buf))
}

fn read_i16_le<R: Read>(reader: &mut R) -> Result<i16, ApiError> {
    let mut buf = [0u8; 2];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(i16::from_le_bytes(buf))
}

fn read_u32_le<R: Read>(reader: &mut R) -> Result<u32, ApiError> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(u32::from_le_bytes(buf))
}

fn read_i32_le<R: Read>(reader: &mut R) -> Result<i32, ApiError> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(i32::from_le_bytes(buf))
}

fn read_u64_le<R: Read>(reader: &mut R) -> Result<u64, ApiError> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(u64::from_le_bytes(buf))
}

fn read_i64_le<R: Read>(reader: &mut R) -> Result<i64, ApiError> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(i64::from_le_bytes(buf))
}

fn read_f32_le<R: Read>(reader: &mut R) -> Result<f32, ApiError> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(f32::from_le_bytes(buf))
}

fn read_f64_le<R: Read>(reader: &mut R) -> Result<f64, ApiError> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf).map_err(ApiError::internal)?;
    Ok(f64::from_le_bytes(buf))
}

/// Ollama の `parameters` テキスト（Modelfile 形式）をパースして
/// ストップトークンのリストとデフォルト温度を抽出する。
///
/// 入力例:
/// ```text
/// stop "<|start_header_id|>"
/// stop "<|end_header_id|>"
/// stop "<|eot_id|>"
/// temperature 0.2
/// ```
fn parse_ollama_parameters(parameters: &str) -> (Option<Vec<String>>, Option<f32>) {
    let mut stop_tokens: Vec<String> = Vec::new();
    let mut temperature: Option<f32> = None;

    for line in parameters.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("stop") {
            // 値は引用符で囲まれている可能性がある: stop "<|eot_id|>"
            let value = rest.trim().trim_matches('"').to_string();
            if !value.is_empty() {
                stop_tokens.push(value);
            }
        } else if let Some(rest) = line.strip_prefix("temperature") {
            if let Ok(t) = rest.trim().parse::<f32>() {
                temperature = Some(t);
            }
        }
    }

    let stop_tokens = if stop_tokens.is_empty() {
        None
    } else {
        Some(stop_tokens)
    };

    (stop_tokens, temperature)
}

/// Ollama の `model_info` マップからコンテキスト長を抽出する。
/// キー名はアーキテクチャに依存するため、`<arch>.context_length` を優先しつつ
/// `context_length` を含む任意のキーにフォールバックする。
fn extract_context_length(
    model_info: Option<&std::collections::HashMap<String, serde_json::Value>>,
    architecture: Option<&str>,
) -> Option<u64> {
    let info = model_info?;

    // まずアーキテクチャ固有キー（例: "gemma3.context_length"）を試みる
    if let Some(arch) = architecture {
        let key = format!("{}.context_length", arch);
        if let Some(v) = info.get(&key).and_then(|v| v.as_u64()) {
            return Some(v);
        }
    }

    // フォールバック: "context_length" を含む任意のキー
    info.iter()
        .filter(|(k, _)| k.contains("context_length"))
        .find_map(|(_, v)| v.as_u64())
}

fn unique_model_id(base: &str, models: &[ModelEntry]) -> String {
    if !models.iter().any(|m| m.id == base) {
        return base.to_string();
    }
    let mut idx = 2;
    loop {
        let candidate = format!("{}-{}", base, idx);
        if !models.iter().any(|m| m.id == candidate) {
            return candidate;
        }
        idx += 1;
    }
}

/// モデルファイル名をサニタイズする。ベース名のみ許可し、トラバーサルを拒否。
fn sanitize_model_filename(filename: &str) -> Option<&str> {
    if filename.is_empty() {
        return None;
    }
    let base = Path::new(filename).file_name().and_then(|n| n.to_str())?;
    if base == filename {
        Some(base)
    } else {
        None
    }
}

fn evaluate_download_policy_from_config(
    config: &Value,
    repo_id: &str,
    revision: Option<&str>,
    expected_sha256: Option<&str>,
) -> ModelDownloadPolicy {
    let allowlist = config
        .get("model_download")
        .and_then(|v| v.get("allow_repo_owners"))
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    let require_allowlist = config
        .get("model_download")
        .and_then(|v| v.get("require_allowlist"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let warn_on_unlisted = config
        .get("model_download")
        .and_then(|v| v.get("warn_on_unlisted"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let require_revision = config
        .get("model_download")
        .and_then(|v| v.get("require_revision"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let require_sha256 = config
        .get("model_download")
        .and_then(|v| v.get("require_sha256"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let owner = repo_id.split('/').next().unwrap_or("").to_lowercase();
    let allowset: HashSet<String> = allowlist.into_iter().map(|s| s.to_lowercase()).collect();

    let mut allowed = true;
    let mut requires_consent = false;
    let mut warnings = Vec::new();

    let normalized_revision = revision.map(str::trim).filter(|value| !value.is_empty());
    let normalized_sha256 = normalize_sha256(expected_sha256);

    if !owner.is_empty() && !allowset.contains(&owner) {
        if require_allowlist {
            allowed = false;
            warnings.push("Repository owner is not in allowlist".to_string());
        } else if warn_on_unlisted {
            requires_consent = true;
            warnings.push("Repository owner is not in allowlist".to_string());
        }
    }

    if require_revision && normalized_revision.is_none() {
        allowed = false;
        warnings.push("Revision pinning is required by policy (provide a revision)".to_string());
    }

    if require_sha256 {
        if normalized_sha256.is_none() {
            allowed = false;
            warnings.push(
                "SHA256 verification is required by policy (provide expected sha256)".to_string(),
            );
        }
    } else if expected_sha256.is_some() && normalized_sha256.is_none() {
        allowed = false;
        warnings.push("Provided SHA256 value is not a valid 64-char hex string".to_string());
    }

    ModelDownloadPolicy {
        allowed,
        requires_consent,
        warnings,
    }
}

fn hf_resolve_url(repo_id: &str, filename: &str, revision: Option<&str>) -> String {
    let revision = revision
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main");
    format!(
        "https://huggingface.co/{}/resolve/{}/{}?download=true",
        repo_id,
        urlencoding::encode(revision),
        filename
    )
}

fn normalize_sha256(value: Option<&str>) -> Option<String> {
    let trimmed = value.map(str::trim).filter(|v| !v.is_empty())?;
    if trimmed.len() != 64 {
        return None;
    }
    if !trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn policy_requires_revision_and_sha_when_configured() {
        let config = json!({
            "model_download": {
                "require_revision": true,
                "require_sha256": true,
                "warn_on_unlisted": false
            }
        });

        let blocked = evaluate_download_policy_from_config(&config, "owner/model", None, None);
        assert!(!blocked.allowed);
        assert!(blocked
            .warnings
            .iter()
            .any(|w| w.contains("Revision pinning is required")));
        assert!(blocked
            .warnings
            .iter()
            .any(|w| w.contains("SHA256 verification is required")));
    }

    #[test]
    fn policy_accepts_valid_sha_when_required() {
        let config = json!({
            "model_download": {
                "require_revision": true,
                "require_sha256": true,
                "warn_on_unlisted": false
            }
        });
        let valid_sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        let policy = evaluate_download_policy_from_config(
            &config,
            "owner/model",
            Some("refs/pr/1"),
            Some(valid_sha),
        );
        assert!(policy.allowed);
    }

    #[test]
    fn hf_url_uses_revision_when_provided() {
        let url = hf_resolve_url("owner/model", "file.gguf", Some("abc123"));
        assert!(url.contains("/resolve/abc123/"));
    }

    #[test]
    fn hf_url_defaults_to_main_when_revision_missing() {
        let url = hf_resolve_url("owner/model", "file.gguf", None);
        assert!(url.contains("/resolve/main/"));
    }

    #[test]
    fn hf_url_encodes_revision_value() {
        let url = hf_resolve_url("owner/model", "file.gguf", Some("feature branch"));
        assert!(url.contains("/resolve/feature%20branch/"));
    }

    #[test]
    fn normalize_sha_rejects_invalid_value() {
        assert!(normalize_sha256(Some("not-a-hash")).is_none());
        assert!(normalize_sha256(Some("")).is_none());
        assert!(normalize_sha256(Some("A")).is_none());
    }

    #[test]
    fn policy_requires_consent_for_unlisted_owner_when_warn_enabled() {
        let config = json!({
            "model_download": {
                "allow_repo_owners": ["trusted"],
                "require_allowlist": false,
                "warn_on_unlisted": true
            }
        });

        let policy =
            evaluate_download_policy_from_config(&config, "external/model", Some("main"), None);

        assert!(policy.allowed);
        assert!(policy.requires_consent);
        assert!(policy.warnings.iter().any(|w| w.contains("allowlist")));
    }

    #[test]
    fn policy_blocks_unlisted_owner_when_require_allowlist_enabled() {
        let config = json!({
            "model_download": {
                "allow_repo_owners": ["trusted"],
                "require_allowlist": true,
                "warn_on_unlisted": true
            }
        });

        let policy =
            evaluate_download_policy_from_config(&config, "external/model", Some("main"), None);

        assert!(!policy.allowed);
        assert!(!policy.requires_consent);
        assert!(policy.warnings.iter().any(|w| w.contains("allowlist")));
    }

    #[test]
    fn policy_accepts_allowlisted_owner_case_insensitively() {
        let config = json!({
            "model_download": {
                "allow_repo_owners": ["TrustedOwner"],
                "require_allowlist": true
            }
        });

        let policy =
            evaluate_download_policy_from_config(&config, "trustedowner/model", None, None);
        assert!(policy.allowed);
        assert!(!policy.requires_consent);
        assert!(policy.warnings.is_empty());
    }

    #[test]
    fn policy_rejects_invalid_sha_even_when_sha_not_required() {
        let config = json!({
            "model_download": {
                "require_sha256": false
            }
        });

        let policy =
            evaluate_download_policy_from_config(&config, "owner/model", None, Some("bad-sha"));
        assert!(!policy.allowed);
        assert!(policy
            .warnings
            .iter()
            .any(|w| w.contains("valid 64-char hex")));
    }

    #[test]
    fn parse_ollama_parameters_extracts_stop_tokens_and_temperature() {
        let input =
            "stop \"<|start_header_id|>\"\nstop \"<|end_header_id|>\"\nstop \"<|eot_id|>\"\ntemperature 0.2";
        let (stops, temp) = parse_ollama_parameters(input);
        let stops = stops.expect("stop tokens should be present");
        assert_eq!(stops.len(), 3);
        assert!(stops.contains(&"<|eot_id|>".to_string()));
        assert_eq!(temp, Some(0.2));
    }

    #[test]
    fn parse_ollama_parameters_returns_none_when_empty() {
        let (stops, temp) = parse_ollama_parameters("");
        assert!(stops.is_none());
        assert!(temp.is_none());
    }

    #[test]
    fn determine_ollama_role_detects_embedding_by_family() {
        let details = OllamaModelDetails {
            family: Some("bert".to_string()),
            ..Default::default()
        };
        let role = determine_ollama_role("nomic-embed-text", &details, None, None);
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_detects_embedding_by_capability() {
        let details = OllamaModelDetails::default();
        let capabilities = vec!["embedding".to_string()];
        let role = determine_ollama_role("mystery-model", &details, Some(&capabilities), None);
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_detects_embeddinggemma_by_name() {
        let details = OllamaModelDetails {
            family: Some("gemma3".to_string()),
            ..Default::default()
        };
        let role = determine_ollama_role("embeddinggemma:latest", &details, None, None);
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_prefers_gguf_metadata_when_available() {
        let details = OllamaModelDetails {
            family: Some("bert".to_string()),
            ..Default::default()
        };
        let mut info = HashMap::new();
        info.insert(
            "general.type".to_string(),
            Value::String("text".to_string()),
        );
        let role = determine_ollama_role("some-embed-model", &details, None, Some(&info));
        assert_eq!(role, "text");
    }

    #[test]
    fn infer_role_from_gguf_metadata_detects_pooling_as_embedding() {
        let mut info = HashMap::new();
        info.insert(
            "general.architecture".to_string(),
            Value::String("llama".to_string()),
        );
        info.insert("llama.pooling_type".to_string(), Value::Number(1u64.into()));

        let role = infer_role_from_gguf_metadata("custom-model.gguf", &info);
        assert_eq!(role, Some("embedding".to_string()));
    }

    #[test]
    fn read_gguf_metadata_parses_basic_string_entry() {
        fn push_u32(buf: &mut Vec<u8>, v: u32) {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        fn push_u64(buf: &mut Vec<u8>, v: u64) {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        fn push_gguf_string(buf: &mut Vec<u8>, s: &str) {
            push_u64(buf, s.len() as u64);
            buf.extend_from_slice(s.as_bytes());
        }

        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"GGUF");
        push_u32(&mut bytes, 3); // version
        push_u64(&mut bytes, 0); // tensor_count
        push_u64(&mut bytes, 1); // kv_count
        push_gguf_string(&mut bytes, "general.type");
        push_u32(&mut bytes, 8); // string
        push_gguf_string(&mut bytes, "embedding");

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sample.gguf");
        fs::write(&path, bytes).expect("write gguf");

        let metadata = read_gguf_metadata(&path).expect("metadata should parse");
        assert_eq!(
            metadata
                .get("general.type")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "embedding"
        );
    }

    fn make_model_entry(
        id: &str,
        role: &str,
        source: &str,
        loader: &str,
        filename: &str,
        capabilities: Option<ModelCapabilities>,
    ) -> ModelEntry {
        ModelEntry {
            id: id.to_string(),
            display_name: id.to_string(),
            role: role.to_string(),
            file_size: 1,
            filename: filename.to_string(),
            source: source.to_string(),
            file_path: format!("{}://{}", source, filename),
            loader: loader.to_string(),
            loader_model_name: Some(filename.to_string()),
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
            capabilities,
            publisher: None,
            description: None,
            format: Some("gguf".to_string()),
        }
    }

    #[test]
    fn migrate_legacy_loader_roles_reclassifies_embedding_name() {
        let mut registry = ModelRegistry {
            models: vec![make_model_entry(
                "ollama-embeddinggemma:latest",
                "text",
                "ollama",
                "ollama",
                "embeddinggemma:latest",
                None,
            )],
            ..Default::default()
        };

        let changed = migrate_legacy_loader_roles(&mut registry);

        assert!(changed);
        assert_eq!(registry.models[0].role, "embedding");
    }

    #[test]
    fn migrate_legacy_loader_roles_reclassifies_embedding_like_capabilities() {
        let mut registry = ModelRegistry {
            models: vec![make_model_entry(
                "ollama-unknown",
                "text",
                "ollama",
                "ollama",
                "custom-model",
                Some(ModelCapabilities {
                    completion: false,
                    tool_use: false,
                    vision: false,
                }),
            )],
            ..Default::default()
        };

        let changed = migrate_legacy_loader_roles(&mut registry);

        assert!(changed);
        assert_eq!(registry.models[0].role, "embedding");
    }

    #[test]
    fn extract_context_length_uses_arch_specific_key() {
        let mut info = std::collections::HashMap::new();
        info.insert(
            "gemma3.context_length".to_string(),
            serde_json::Value::Number(32768.into()),
        );
        let result = extract_context_length(Some(&info), Some("gemma3"));
        assert_eq!(result, Some(32768));
    }

    #[test]
    fn extract_context_length_falls_back_to_generic_key() {
        let mut info = std::collections::HashMap::new();
        info.insert(
            "llm.context_length".to_string(),
            serde_json::Value::Number(4096.into()),
        );
        let result = extract_context_length(Some(&info), None);
        assert_eq!(result, Some(4096));
    }

    #[test]
    fn sanitize_model_filename_accepts_normal_name() {
        assert_eq!(sanitize_model_filename("model.gguf"), Some("model.gguf"));
        assert_eq!(
            sanitize_model_filename("my-model-v2.gguf"),
            Some("my-model-v2.gguf")
        );
    }

    #[test]
    fn sanitize_model_filename_rejects_traversal() {
        assert_eq!(sanitize_model_filename("../config.json"), None);
        assert_eq!(sanitize_model_filename("..\\config.json"), None);
        assert_eq!(sanitize_model_filename("sub/model.gguf"), None);
        assert_eq!(sanitize_model_filename("sub\\model.gguf"), None);
    }

    #[test]
    fn sanitize_model_filename_rejects_absolute_path() {
        assert_eq!(sanitize_model_filename("/etc/passwd"), None);
        assert_eq!(sanitize_model_filename("C:\\Windows\\foo.gguf"), None);
    }

    #[test]
    fn sanitize_model_filename_rejects_empty() {
        assert_eq!(sanitize_model_filename(""), None);
    }
}
