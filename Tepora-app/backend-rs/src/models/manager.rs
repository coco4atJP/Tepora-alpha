use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use reqwest::Client;
use serde_json::Value;

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;

use super::discovery;
use super::download;
use super::metadata::{
    extract_architecture_from_model_info, extract_context_length, infer_role_from_gguf_metadata,
    read_gguf_metadata, sanitize_model_filename,
};
use super::registry::ModelRegistryStore;
use super::selection;
use super::types::{ModelDownloadPolicy, ModelDownloadResult, ModelEntry, ModelRegistry};

#[derive(Clone)]
pub struct ModelManager {
    paths: AppPaths,
    config: ConfigService,
    client: Client,
    store: ModelRegistryStore,
}

impl ModelManager {
    pub fn new(paths: &AppPaths, config: ConfigService) -> Self {
        let store = ModelRegistryStore::new(paths.user_data_dir.join("models.json"));
        Self {
            paths: paths.clone(),
            config,
            client: Client::new(),
            store,
        }
    }

    pub fn list_models(&self) -> Result<Vec<ModelEntry>, ApiError> {
        self.store.list_models()
    }

    pub fn get_registry(&self) -> Result<ModelRegistry, ApiError> {
        self.store.load()
    }

    #[allow(dead_code)]
    pub(crate) fn save_registry(&self, registry: &ModelRegistry) -> Result<(), ApiError> {
        self.store.save(registry)
    }

    pub fn get_model(&self, model_id: &str) -> Result<Option<ModelEntry>, ApiError> {
        self.store.get_model(model_id)
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
            id: self.store.next_unique_id(&model_id)?,
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
            tokenizer_path: None,
            tokenizer_format: None,
        };

        self.store.insert_model(entry)
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

        let url = download::hf_resolve_url(repo_id, filename, revision);
        let downloaded = match download::download_model_file(
            &self.client,
            &url,
            &target_path,
            expected_sha256,
            progress_cb,
        )
        .await
        {
            Ok(file) => file,
            Err(ApiError::BadRequest(message))
                if message.contains("SHA256 did not match expected value") =>
            {
                return Ok(ModelDownloadResult {
                    success: false,
                    requires_consent: false,
                    warnings: vec!["SHA256 verification failed".to_string()],
                    path: None,
                    error_message: Some(message),
                    model_id: None,
                });
            }
            Err(err) => return Err(err),
        };

        let normalized_revision = revision
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string());
        let sha256 = Some(downloaded.sha256.clone());
        let entry = self.store.upsert_downloaded_model(
            repo_id,
            filename,
            role,
            display_name,
            &downloaded.path,
            downloaded.file_size,
            normalized_revision,
            sha256,
        )?;

        Ok(ModelDownloadResult {
            success: true,
            requires_consent: false,
            warnings: policy.warnings,
            path: Some(downloaded.path),
            error_message: None,
            model_id: Some(entry.id),
        })
    }

    pub fn delete_model(&self, model_id: &str) -> Result<bool, ApiError> {
        self.store.delete_model(&self.paths, model_id)
    }

    #[allow(dead_code)]
    pub async fn get_remote_file_size(
        &self,
        repo_id: &str,
        filename: &str,
    ) -> Result<Option<u64>, ApiError> {
        download::get_remote_file_size(&self.client, repo_id, filename).await
    }

    pub async fn check_update(
        &self,
        repo_id: &str,
        filename: &str,
        revision: Option<&str>,
        current_sha: Option<&str>,
        current_size: Option<u64>,
    ) -> Result<Value, ApiError> {
        download::check_update(
            &self.client,
            repo_id,
            filename,
            revision,
            current_sha,
            current_size,
        )
        .await
    }

    pub fn set_assignment_model(
        &self,
        assignment_key: &str,
        model_id: &str,
    ) -> Result<bool, ApiError> {
        self.store.set_assignment_model(assignment_key, model_id)
    }

    pub fn resolve_assignment_model(
        &self,
        assignment_key: &str,
    ) -> Result<Option<ModelEntry>, ApiError> {
        let registry = self.store.load()?;
        selection::resolve_assignment_model_from_registry(&registry, assignment_key)
    }

    pub fn resolve_assignment_model_id(
        &self,
        assignment_key: &str,
    ) -> Result<Option<String>, ApiError> {
        let registry = self.store.load()?;
        selection::resolve_assignment_model_id_from_registry(&registry, assignment_key)
    }

    pub fn resolve_character_model(
        &self,
        active_character_id: Option<&str>,
    ) -> Result<Option<ModelEntry>, ApiError> {
        let registry = self.store.load()?;
        Ok(selection::resolve_character_model(
            &registry,
            active_character_id,
        ))
    }

    pub fn resolve_character_model_id(
        &self,
        active_character_id: Option<&str>,
    ) -> Result<Option<String>, ApiError> {
        let registry = self.store.load()?;
        Ok(selection::resolve_character_model_id_from_registry(
            &registry,
            active_character_id,
        ))
    }

    pub fn resolve_agent_model_id(
        &self,
        agent_id: Option<&str>,
    ) -> Result<Option<String>, ApiError> {
        let registry = self.store.load()?;
        Ok(selection::resolve_agent_model_id_from_registry(
            &registry, agent_id,
        ))
    }

    pub fn resolve_embedding_model(&self) -> Result<Option<ModelEntry>, ApiError> {
        let registry = self.store.load()?;
        Ok(selection::resolve_embedding_model(&registry))
    }

    pub fn resolve_embedding_model_id(&self) -> Result<Option<String>, ApiError> {
        let registry = self.store.load()?;
        Ok(selection::resolve_embedding_model_id_from_registry(
            &registry,
        ))
    }

    pub fn find_first_model_by_modality(
        &self,
        modality: &str,
    ) -> Result<Option<ModelEntry>, ApiError> {
        let registry = self.store.load()?;
        Ok(selection::find_first_model_by_modality(&registry, modality))
    }

    pub fn remove_assignment(&self, assignment_key: &str) -> Result<bool, ApiError> {
        self.store.remove_assignment(assignment_key)
    }

    pub fn reorder_models(
        &self,
        modality: &str,
        model_ids: Vec<String>,
    ) -> Result<bool, ApiError> {
        self.store.reorder_models(modality, model_ids)
    }

    pub fn evaluate_download_policy(
        &self,
        repo_id: &str,
        _filename: &str,
        revision: Option<&str>,
        expected_sha256: Option<&str>,
    ) -> ModelDownloadPolicy {
        let config = self.config.load_config().unwrap_or(Value::Null);
        download::evaluate_download_policy_from_config(&config, repo_id, revision, expected_sha256)
    }

    pub async fn refresh_all_loader_models(&self) -> Result<usize, ApiError> {
        let mut count = 0;
        count += self.refresh_llama_cpp_models().await?;
        count += self.refresh_ollama_models().await?;
        count += self.refresh_lmstudio_models().await?;
        Ok(count)
    }

    pub async fn refresh_ollama_models(&self) -> Result<usize, ApiError> {
        let discovered = discovery::refresh_ollama_models(&self.config).await?;
        self.store.apply_discovered_models("ollama", discovered)
    }

    pub async fn refresh_lmstudio_models(&self) -> Result<usize, ApiError> {
        let discovered = discovery::refresh_lmstudio_models(&self.config).await?;
        self.store.apply_discovered_models("lmstudio", discovered)
    }

    pub async fn refresh_llama_cpp_models(&self) -> Result<usize, ApiError> {
        let registry = self.store.load()?;
        let discovered = discovery::refresh_llama_cpp_models(registry.models).await?;
        self.store.apply_discovered_models("llama_cpp", discovered)
    }

    fn model_storage_path(&self, role: &str, filename: &str) -> Result<PathBuf, ApiError> {
        let safe_role = role.to_lowercase();
        let base = self.paths.user_data_dir.join("models").join(safe_role);
        let safe_filename = sanitize_model_filename(filename)
            .ok_or_else(|| ApiError::BadRequest("Invalid model filename".to_string()))?;
        Ok(base.join(safe_filename))
    }
}
