use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::{AppPaths, ConfigService};
use crate::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    pub role: String,
    pub file_size: u64,
    pub filename: String,
    pub source: String,
    pub file_path: String,
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelRegistry {
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    #[serde(default)]
    pub role_assignments: HashMap<String, String>,
    #[serde(default)]
    pub role_order: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ModelDownloadPolicy {
    pub allowed: bool,
    pub requires_consent: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ModelDownloadResult {
    pub success: bool,
    pub requires_consent: bool,
    pub warnings: Vec<String>,
    pub path: Option<PathBuf>,
    pub error_message: Option<String>,
    pub model_id: Option<String>,
}

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
        };

        let mut registry = self.load_registry()?;
        registry.models.push(entry.clone());
        self.save_registry(&registry)?;
        Ok(entry)
    }

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

        if let Some(path) = remove_path {
            if path.starts_with(&self.paths.user_data_dir) {
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
        let config = self.config.load_config().unwrap_or_else(|_| Value::Null);
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
        Ok(base.join(filename))
    }

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
        let base_id = format!("{}-{}", role, filename);
        let id = unique_model_id(&base_id, &registry.models);

        let entry = ModelEntry {
            id: id.clone(),
            display_name: display_name.to_string(),
            role: role.to_string(),
            file_size,
            filename: filename.to_string(),
            source: repo_id.to_string(),
            file_path: path.to_string_lossy().to_string(),
            repo_id: Some(repo_id.to_string()),
            revision,
            sha256,
            added_at: Utc::now().to_rfc3339(),
        };

        registry.models.push(entry.clone());
        self.save_registry(&registry)?;
        Ok(entry)
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
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
}
