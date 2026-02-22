use std::collections::HashSet;
use std::fs;
use std::io::Write;
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
        let model_id = format!(
            "{}-{}",
            role.to_lowercase(),
            file_path
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("model")
        );

        let entry = ModelEntry {
            id: unique_model_id(&model_id, &self.load_registry()?.models),
            display_name: display_name.to_string(),
            role: role.to_string(),
            file_size: metadata.len(),
            filename: file_path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or_default()
                .to_string(),
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
            context_length: None,
            architecture: None,
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
            let still_referenced = registry.models.iter().any(|m| m.file_path == path_str.as_ref());
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
        if !registry.models.iter().any(|m| m.id == model_id) {
            return Ok(false);
        }
        registry
            .role_assignments
            .insert(role.to_string(), model_id.to_string());
        self.save_registry(&registry)?;
        Ok(true)
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

        // C-2 fix: repo_id + filename + role で既存エントリを検索し、あれば更新
        if let Some(existing) = registry.models.iter_mut().find(|m| {
            m.repo_id.as_deref() == Some(repo_id)
                && m.filename == filename
                && m.role == role
        }) {
            existing.display_name = display_name.to_string();
            existing.file_path = file_path_str;
            existing.file_size = file_size;
            existing.revision = revision;
            existing.sha256 = sha256;
            existing.added_at = Utc::now().to_rfc3339();
            let updated = existing.clone();
            self.save_registry(&registry)?;
            return Ok(updated);
        }

        // 新規追加
        let base_id = format!("{}-{}", role, filename);
        let id = unique_model_id(&base_id, &registry.models);

        let entry = ModelEntry {
            id: id.clone(),
            display_name: display_name.to_string(),
            role: role.to_string(),
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
            context_length: None,
            architecture: None,
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
        let base_url = self.get_loader_url("ollama", "http://localhost:11434");

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(ApiError::internal)?;

        // 1. モデル一覧を取得
        let res = client.get(format!("{}/api/tags", base_url)).send().await;
        let Ok(response) = res else {
            return Ok(0);
        };
        if !response.status().is_success() {
            return Ok(0);
        }

        let tags: OllamaTagsResponse = response.json().await.map_err(ApiError::internal)?;
        let mut count = 0;
        let mut registry = self.load_registry()?;
        let now = Utc::now().to_rfc3339();

        for model in tags.models {
            let model_id = format!("ollama-{}", model.name);

            // 2. 各モデルの詳細情報を /api/show で取得（失敗しても続行）
            let show: Option<OllamaShowResponse> = {
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
            let role = determine_ollama_role(
                &model.name,
                details,
                show.as_ref().and_then(|s| s.capabilities.as_deref()),
            );

            // スペック情報を抽出
            let parameter_size = details.parameter_size.clone();
            let quantization = details.quantization_level.clone();
            let format = details.format.clone();
            let architecture = show.as_ref().and_then(|s| {
                s.model_info.as_ref().and_then(|info| {
                    info.get("general.architecture")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
            });
            let context_length = show.as_ref().and_then(|s| {
                extract_context_length(s.model_info.as_ref(), architecture.as_deref())
            });
            let chat_template = show.as_ref().and_then(|s| s.template.clone());
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

            // 3. 既存エントリは情報を更新、なければ新規追加
            if let Some(existing) = registry.models.iter_mut().find(|m| m.id == model_id) {
                let changed = existing.role != role
                    || existing.parameter_size != parameter_size
                    || existing.quantization != quantization
                    || existing.architecture != architecture
                    || existing.context_length != context_length
                    || existing.chat_template != chat_template;

                existing.role = role;
                existing.parameter_size = parameter_size;
                existing.quantization = quantization;
                existing.format = format;
                existing.architecture = architecture;
                existing.context_length = context_length;
                existing.chat_template = chat_template;
                if stop_tokens.is_some() {
                    existing.stop_tokens = stop_tokens;
                }
                if default_temperature.is_some() {
                    existing.default_temperature = default_temperature;
                }
                if capabilities.is_some() {
                    existing.capabilities = capabilities;
                }
                if changed {
                    count += 1;
                }
                continue;
            }

            let entry = ModelEntry {
                id: model_id,
                display_name: format!("{} (Ollama)", model.name),
                role,
                file_size: model.size,
                filename: model.name.clone(),
                source: "ollama".to_string(),
                file_path: format!("ollama://{}", model.name),
                loader: "ollama".to_string(),
                loader_model_name: Some(model.name.clone()),
                repo_id: None,
                revision: None,
                sha256: Some(model.digest),
                added_at: now.clone(),
                parameter_size,
                quantization,
                context_length,
                architecture,
                chat_template,
                stop_tokens,
                default_temperature,
                capabilities,
                publisher: None,
                description: None,
                format,
            };
            registry.models.push(entry);
            count += 1;
        }

        if count > 0 {
            self.save_registry(&registry)?;
        }

        Ok(count)
    }

    pub async fn refresh_lmstudio_models(&self) -> Result<usize, ApiError> {
        let base_url = self.get_loader_url("lmstudio", "http://localhost:1234");

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(ApiError::internal)?;

        // LM Studio 独自の /api/v1/models を使用（詳細情報あり）
        let res = client
            .get(format!("{}/api/v1/models", base_url))
            .send()
            .await;

        let Ok(response) = res else {
            return Ok(0);
        };
        if !response.status().is_success() {
            return Ok(0);
        }

        let body: LmStudioV1Response = response.json().await.map_err(ApiError::internal)?;
        let mut count = 0;
        let mut registry = self.load_registry()?;
        let now = Utc::now().to_rfc3339();

        for model in body.models {
            let model_id = format!("lmstudio-{}", model.key);

            // type フィールドから role を直接決定
            let role = if model.model_type == "embedding" {
                "embedding".to_string()
            } else {
                "text".to_string()
            };

            let display_name = model
                .display_name
                .as_deref()
                .unwrap_or(&model.key)
                .to_string();
            let quantization = model.quantization.as_ref().and_then(|q| q.name.clone());
            let capabilities = model.capabilities.as_ref().map(|c| ModelCapabilities {
                completion: role == "text",
                tool_use: c.trained_for_tool_use,
                vision: c.vision,
            });

            // 既存エントリは情報を更新
            if let Some(existing) = registry.models.iter_mut().find(|m| m.id == model_id) {
                let changed = existing.role != role
                    || existing.context_length != model.max_context_length
                    || existing.quantization != quantization
                    || existing.parameter_size != model.params_string;

                existing.role = role;
                existing.display_name = format!("{} (LM Studio)", display_name);
                existing.file_size = model.size_bytes.unwrap_or(0);
                existing.parameter_size = model.params_string.clone();
                existing.quantization = quantization;
                existing.context_length = model.max_context_length;
                existing.architecture = model.architecture.clone();
                existing.publisher = model.publisher.clone();
                existing.description = model.description.clone();
                existing.format = model.format.clone();
                if capabilities.is_some() {
                    existing.capabilities = capabilities;
                }
                if changed {
                    count += 1;
                }
                continue;
            }

            let entry = ModelEntry {
                id: model_id,
                display_name: format!("{} (LM Studio)", display_name),
                role,
                file_size: model.size_bytes.unwrap_or(0),
                filename: model.key.clone(),
                source: "lmstudio".to_string(),
                file_path: format!("lmstudio://{}", model.key),
                loader: "lmstudio".to_string(),
                loader_model_name: Some(model.key.clone()),
                repo_id: None,
                revision: None,
                sha256: None,
                added_at: now.clone(),
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
            };
            registry.models.push(entry);
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
        serde_json::from_str(&contents).map_err(ApiError::internal)
    }
}

/// Ollamaモデルの情報からroleを推定する。
/// family/families だけでは判定できないケース（例: embeddinggemma）に対応するため、
/// capabilities とモデル名ヒントも併用する。
fn determine_ollama_role(
    model_name: &str,
    details: &OllamaModelDetails,
    capabilities: Option<&[String]>,
) -> String {
    const EMBEDDING_FAMILIES: &[&str] = &["bert", "nomic-bert", "clip"];
    const EMBEDDING_CAPABILITY_HINTS: &[&str] = &["embedding", "embed"];
    const TEXT_CAPABILITY_HINTS: &[&str] = &["completion", "chat", "generate"];
    const EMBEDDING_NAME_HINTS: &[&str] = &[
        "embedding",
        "embed",
        "nomic-embed",
        "e5",
        "bge",
        "gte",
    ];

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
    } else if EMBEDDING_NAME_HINTS
        .iter()
        .any(|hint| model_name.to_ascii_lowercase().contains(hint))
    {
        "embedding".to_string()
    } else {
        "text".to_string()
    }
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
    let base = Path::new(filename)
        .file_name()
        .and_then(|n| n.to_str())?;
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
        let role = determine_ollama_role("nomic-embed-text", &details, None);
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_detects_embedding_by_capability() {
        let details = OllamaModelDetails::default();
        let capabilities = vec!["embedding".to_string()];
        let role = determine_ollama_role("mystery-model", &details, Some(&capabilities));
        assert_eq!(role, "embedding");
    }

    #[test]
    fn determine_ollama_role_detects_embeddinggemma_by_name() {
        let details = OllamaModelDetails {
            family: Some("gemma3".to_string()),
            ..Default::default()
        };
        let role = determine_ollama_role("embeddinggemma:latest", &details, None);
        assert_eq!(role, "embedding");
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
        assert_eq!(sanitize_model_filename("my-model-v2.gguf"), Some("my-model-v2.gguf"));
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
