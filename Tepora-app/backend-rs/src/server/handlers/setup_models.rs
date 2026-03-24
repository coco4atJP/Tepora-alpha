use std::collections::HashMap;

use serde_json::{json, Value};

use crate::core::errors::ApiError;
use crate::state::AppStateWrite;

use crate::server::handlers::setup::{DownloadModelRequest, ModelUpdateCheckTarget};

#[derive(Debug, Clone)]
pub struct ModelDownloadSpec {
    pub repo_id: String,
    pub filename: String,
    pub modality: String,
    pub assignment_key: Option<String>,
    pub display_name: String,
    pub revision: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DownloadTask {
    pub repo_id: String,
    pub filename: String,
    pub modality: String,
    pub assignment_key: Option<String>,
    pub display_name: String,
    pub revision: Option<String>,
    pub sha256: Option<String>,
    pub consent: bool,
}

pub async fn run_download_job(state: AppStateWrite, tasks: Vec<DownloadTask>) {
    let total = tasks.len().max(1) as f32;
    for (idx, task) in tasks.into_iter().enumerate() {
        let base_progress = idx as f32 / total;
        let progress_cb = |p: f32, message: &str| {
            let _ = state.core().setup.update_progress(
                "downloading",
                base_progress + (p / total),
                message,
            );
        };

        let result = state
            .ai()
            .models
                .download_from_huggingface(
                    &task.repo_id,
                    &task.filename,
                    &task.modality,
                    &task.display_name,
                    task.revision.as_deref(),
                    task.sha256.as_deref(),
                task.consent,
                Some(&progress_cb),
            )
            .await;

        match result {
            Ok(dl_result) if dl_result.success => {
                if let (Some(model_id), Some(assignment_key)) =
                    (dl_result.model_id.as_deref(), task.assignment_key.as_deref())
                {
                    let assignment = state
                        .ai()
                        .models
                        .set_assignment_model(assignment_key, model_id);
                    if let Err(err) = assignment {
                        tracing::warn!(
                            model_id = %model_id,
                            assignment_key = %assignment_key,
                            error = %err,
                            "Failed to assign downloaded model"
                        );
                    }
                }
            }
            _ => {
                let _ = state
                    .core()
                    .setup
                    .update_progress("failed", 0.0, "Download failed");
                let _ = state.core().setup.set_job_id(None);
                return;
            }
        }
    }

    let _ = state
        .core()
        .setup
        .update_progress("completed", 1.0, "Download completed!");
    let _ = state.core().setup.set_job_id(None);
}

pub fn download_tasks_from_specs(
    specs: Vec<ModelDownloadSpec>,
    consent: bool,
) -> Vec<DownloadTask> {
    specs
        .into_iter()
        .map(|model| DownloadTask {
            repo_id: model.repo_id,
            filename: model.filename,
            modality: model.modality,
            assignment_key: model.assignment_key,
            display_name: model.display_name,
            revision: model.revision,
            sha256: model.sha256,
            consent,
        })
        .collect()
}

pub fn build_download_task_from_request(payload: &DownloadModelRequest) -> DownloadTask {
    let modality = payload.modality.trim();
    let display_name = payload
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&payload.filename);

    DownloadTask {
        repo_id: payload.repo_id.clone(),
        filename: payload.filename.clone(),
        modality: modality.to_string(),
        assignment_key: payload
            .assignment_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        display_name: display_name.to_string(),
        revision: payload
            .revision
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        sha256: payload
            .sha256
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        consent: payload.acknowledge_warnings.unwrap_or(false),
    }
}

pub fn ensure_assignment_model_exists(
    state: &AppStateWrite,
    assignment_key: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let ok = state.ai().models.set_assignment_model(assignment_key, model_id)?;
    if ok {
        Ok(())
    } else {
        Err(ApiError::NotFound("Model not found".to_string()))
    }
}

pub fn ensure_assignment_exists(
    state: &AppStateWrite,
    assignment_key: &str,
) -> Result<(), ApiError> {
    let ok = state.ai().models.remove_assignment(assignment_key)?;
    if ok {
        Ok(())
    } else {
        Err(ApiError::NotFound("Role assignment not found".to_string()))
    }
}

pub fn build_target_models(payload: Option<Vec<Value>>, config: &Value) -> Vec<ModelDownloadSpec> {
    if let Some(list) = payload {
        let mut specs = Vec::new();
        for item in list {
            let repo_id = item
                .get("repo_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let filename = item
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let role = item
                .get("modality")
                .and_then(|v| v.as_str())
                .unwrap_or("text")
                .to_string();
            let assignment_key = item
                .get("assignment_key")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let display_name = item
                .get("display_name")
                .or_else(|| item.get("displayName"))
                .and_then(|v| v.as_str())
                .unwrap_or(&filename)
                .to_string();
            let revision = item
                .get("revision")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            let sha256 = item
                .get("sha256")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            if repo_id.is_empty() || filename.is_empty() {
                continue;
            }
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                modality: role,
                assignment_key,
                display_name,
                revision,
                sha256,
            });
        }
        if !specs.is_empty() {
            return specs;
        }
    }

    collect_default_models(config)
}

pub fn collect_default_models(config: &Value) -> Vec<ModelDownloadSpec> {
    let mut specs = Vec::new();
    if let Some(text_models) = config
        .get("default_models")
        .and_then(|v| v.get("text_models"))
        .and_then(|v| v.as_array())
    {
        for model in text_models {
            let repo_id = model
                .get("repo_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let filename = model
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let display_name = model
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or(&filename)
                .to_string();
            let revision = model
                .get("revision")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            let sha256 = model
                .get("sha256")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            if repo_id.is_empty() || filename.is_empty() {
                continue;
            }
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                modality: "text".to_string(),
                assignment_key: if specs.is_empty() {
                    Some("character".to_string())
                } else {
                    None
                },
                display_name,
                revision,
                sha256,
            });
        }
    }
    if let Some(embedding) = config
        .get("default_models")
        .and_then(|v| v.get("embedding"))
        .and_then(|v| v.as_object())
    {
        let repo_id = embedding
            .get("repo_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let filename = embedding
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let display_name = embedding
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or(&filename)
            .to_string();
        let revision = embedding
            .get("revision")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string());
        let sha256 = embedding
            .get("sha256")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string());
        if !repo_id.is_empty() && !filename.is_empty() {
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                modality: "embedding".to_string(),
                assignment_key: Some("embedding".to_string()),
                display_name,
                revision,
                sha256,
            });
        }
    }
    specs
}

pub fn normalize_model_update_check_response(
    result: &Value,
    current_revision: Option<&str>,
    current_sha256: Option<&str>,
    current_size: Option<u64>,
) -> Value {
    let update_available = result
        .get("has_update")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let latest_tag = result
        .get("remote_etag")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let remote_size = result.get("remote_size").and_then(|value| value.as_u64());

    let reason = if let (Some(current), Some(latest)) = (current_sha256, latest_tag.as_deref()) {
        if current.trim() == latest.trim() {
            "up_to_date"
        } else {
            "sha256_mismatch"
        }
    } else if !update_available {
        if latest_tag.is_none() && remote_size.is_none() {
            "insufficient_data"
        } else {
            "up_to_date"
        }
    } else if latest_tag.is_some() {
        "revision_mismatch"
    } else if let (Some(current), Some(remote)) = (current_size, remote_size) {
        if current == remote {
            "up_to_date"
        } else {
            "unknown"
        }
    } else {
        "insufficient_data"
    };

    json!({
        "update_available": update_available,
        "reason": reason,
        "current_revision": current_revision
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        "latest_revision": latest_tag,
        "current_sha256": current_sha256
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        "latest_sha256": result
            .get("remote_etag")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    })
}

pub fn parse_model_update_check_target(
    params: &HashMap<String, String>,
) -> Result<ModelUpdateCheckTarget<'_>, ApiError> {
    let model_id = params
        .get("model_id")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(id) = model_id {
        return Ok(ModelUpdateCheckTarget::ModelId(id));
    }

    let repo_id = params
        .get("repo_id")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let filename = params
        .get("filename")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let (Some(repo_id), Some(filename)) = (repo_id, filename) {
        let revision = params
            .get("revision")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        return Ok(ModelUpdateCheckTarget::RepoFile {
            repo_id,
            filename,
            revision,
        });
    }

    Err(ApiError::BadRequest(
        "repo_id and filename are required".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_download_task_preserves_revision_sha_and_display_name() {
        let payload = DownloadModelRequest {
            repo_id: "owner/model".to_string(),
            filename: "model.gguf".to_string(),
            modality: "embedding".to_string(),
            assignment_key: Some("embedding".to_string()),
            display_name: Some("Embedding Model".to_string()),
            revision: Some("main".to_string()),
            sha256: Some("a".repeat(64)),
            acknowledge_warnings: Some(true),
        };

        let task = build_download_task_from_request(&payload);

        assert_eq!(task.repo_id, "owner/model");
        assert_eq!(task.filename, "model.gguf");
        assert_eq!(task.modality, "embedding");
        assert_eq!(task.assignment_key.as_deref(), Some("embedding"));
        assert_eq!(task.display_name, "Embedding Model");
        assert_eq!(task.revision.as_deref(), Some("main"));
        assert_eq!(
            task.sha256.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert!(task.consent);
    }

    #[test]
    fn build_download_task_falls_back_to_filename() {
        let payload = DownloadModelRequest {
            repo_id: "owner/model".to_string(),
            filename: "model.gguf".to_string(),
            modality: "text".to_string(),
            assignment_key: None,
            display_name: Some("  ".to_string()),
            revision: None,
            sha256: None,
            acknowledge_warnings: None,
        };

        let task = build_download_task_from_request(&payload);

        assert_eq!(task.modality, "text");
        assert_eq!(task.assignment_key, None);
        assert_eq!(task.display_name, "model.gguf");
        assert_eq!(task.revision, None);
        assert_eq!(task.sha256, None);
        assert!(!task.consent);
    }

    #[test]
    fn normalize_update_check_prefers_hash_reason() {
        let normalized = normalize_model_update_check_response(
            &json!({
                "has_update": true,
                "remote_size": 42,
                "remote_etag": "new-hash"
            }),
            Some("main"),
            Some("old-hash"),
            Some(12),
        );

        assert_eq!(
            normalized.get("update_available").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            normalized.get("reason").and_then(Value::as_str),
            Some("sha256_mismatch")
        );
        assert_eq!(
            normalized.get("current_revision").and_then(Value::as_str),
            Some("main")
        );
        assert_eq!(
            normalized.get("latest_sha256").and_then(Value::as_str),
            Some("new-hash")
        );
    }

    #[test]
    fn normalize_update_check_marks_insufficient_data() {
        let normalized = normalize_model_update_check_response(&json!({}), None, None, None);

        assert_eq!(
            normalized.get("update_available").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            normalized.get("reason").and_then(Value::as_str),
            Some("insufficient_data")
        );
    }
}
