use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::core::errors::ApiError;

use super::types::ModelDownloadPolicy;

pub(crate) struct DownloadedModelFile {
    pub path: PathBuf,
    pub file_size: u64,
    pub sha256: String,
}

pub(crate) fn evaluate_download_policy_from_config(
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
        .unwrap_or(true);
    let warn_on_unlisted = config
        .get("model_download")
        .and_then(|v| v.get("warn_on_unlisted"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let require_revision = config
        .get("model_download")
        .and_then(|v| v.get("require_revision"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let require_sha256 = config
        .get("model_download")
        .and_then(|v| v.get("require_sha256"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

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

#[allow(clippy::type_complexity)]
pub(crate) async fn download_model_file(
    client: &Client,
    url: &str,
    target_path: &Path,
    expected_sha256: Option<&str>,
    progress_cb: Option<&(dyn Fn(f32, &str) + Sync)>,
) -> Result<DownloadedModelFile, ApiError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(ApiError::internal)?
        .error_for_status()
        .map_err(ApiError::internal)?;

    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(target_path).map_err(ApiError::internal)?;
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

    let file_size = fs::metadata(target_path).map_err(ApiError::internal)?.len();
    let actual_sha256 = hex::encode(hasher.finalize());
    if let Some(expected_hash) = normalize_sha256(expected_sha256) {
        if actual_sha256 != expected_hash {
            let _ = fs::remove_file(target_path);
            return Err(ApiError::BadRequest(
                "Downloaded file SHA256 did not match expected value".to_string(),
            ));
        }
    }

    Ok(DownloadedModelFile {
        path: target_path.to_path_buf(),
        file_size,
        sha256: actual_sha256,
    })
}

pub(crate) async fn get_remote_file_size(
    client: &Client,
    repo_id: &str,
    filename: &str,
) -> Result<Option<u64>, ApiError> {
    let url = hf_resolve_url(repo_id, filename, None);
    let response = client.head(url).send().await.map_err(ApiError::internal)?;
    Ok(content_length(response.headers()))
}

pub(crate) async fn check_update(
    client: &Client,
    repo_id: &str,
    filename: &str,
    revision: Option<&str>,
    current_sha: Option<&str>,
    current_size: Option<u64>,
) -> Result<Value, ApiError> {
    let url = hf_resolve_url(repo_id, filename, revision);
    let response = client.head(url).send().await.map_err(ApiError::internal)?;
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

pub(crate) fn hf_resolve_url(repo_id: &str, filename: &str, revision: Option<&str>) -> String {
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

pub(crate) fn normalize_sha256(value: Option<&str>) -> Option<String> {
    let trimmed = value.map(str::trim).filter(|v| !v.is_empty())?;
    if trimmed.len() != 64 {
        return None;
    }
    if !trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

pub(crate) fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

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
                "require_allowlist": false,
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
                "require_revision": false,
                "require_sha256": false,
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
                "require_allowlist": true,
                "require_revision": false,
                "require_sha256": false
            }
        });

        let policy =
            evaluate_download_policy_from_config(&config, "trustedowner/model", None, None);
        assert!(policy.allowed);
        assert!(!policy.requires_consent);
        assert!(policy.warnings.is_empty());
    }

    #[test]
    fn policy_requires_sha_by_default_when_setting_is_absent() {
        let config = json!({});
        let policy = evaluate_download_policy_from_config(&config, "owner/model", None, None);
        assert!(!policy.allowed);
        assert!(policy
            .warnings
            .iter()
            .any(|w| w.contains("SHA256 verification is required")));
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
