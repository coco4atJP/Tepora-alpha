use std::path::Path;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use super::setup::ModelUpdateCheckTarget;
use super::setup_models::{normalize_model_update_check_response, run_download_job, DownloadTask};
use crate::core::errors::ApiError;
use crate::state::{AppStateRead, AppStateWrite};

pub async fn check_model(
    state: &AppStateRead,
    model_id: Option<&str>,
    repo_id: Option<&str>,
    filename: Option<&str>,
) -> Result<Value, ApiError> {
    if let Some(model_id) = model_id {
        let details = state.ai().models.get_model(model_id)?;
        return Ok(json!({ "exists": details.is_some(), "model": details }));
    }

    if let (Some(repo_id), Some(filename)) = (repo_id, filename) {
        let size = state
            .ai()
            .models
            .get_remote_file_size(repo_id, filename)
            .await?;
        return Ok(json!({ "exists": size.is_some(), "size": size }));
    }

    Err(ApiError::BadRequest(
        "model_id or repo_id+filename required".to_string(),
    ))
}

pub fn models_payload(state: &AppStateRead) -> Result<Value, ApiError> {
    let registry = state.ai().models.get_registry()?;
    let models = registry.models.clone();
    let payload: Vec<Value> = models
        .into_iter()
        .map(|model| {
            let active_assignment_keys = registry
                .role_assignments
                .iter()
                .filter_map(|(assignment_key, assigned_model_id)| {
                    if assigned_model_id == &model.id {
                        Some(assignment_key.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            json!({
                "id": model.id,
                "display_name": model.display_name,
                "role": model.role,
                "file_size": model.file_size,
                "filename": model.filename,
                "file_path": model.file_path,
                "source": model.source,
                "loader": model.loader,
                "repo_id": model.repo_id,
                "revision": model.revision,
                "sha256": model.sha256,
                "is_active": !active_assignment_keys.is_empty(),
                "active_assignment_keys": active_assignment_keys,
            })
        })
        .collect();
    Ok(json!({ "models": payload }))
}

pub fn reorder_models(
    state: &AppStateWrite,
    modality: Option<&str>,
    model_ids: Vec<String>,
) -> Result<(), ApiError> {
    let modality = modality
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("text");
    state
        .ai()
        .models
        .reorder_models(modality, model_ids)?;
    Ok(())
}

pub async fn queue_model_download(
    state: &AppStateWrite,
    repo_id: &str,
    filename: &str,
    task: DownloadTask,
) -> Result<Response, ApiError> {
    state
        .core()
        .security
        .ensure_lockdown_disabled("model_download")?;
    state.core().security.record_audit(
        "model_download_requested",
        "requested",
        json!({"repo_id": repo_id, "filename": filename}),
    )?;
    let consent = task.consent;

    let policy = state.ai().models.evaluate_download_policy(
        repo_id,
        filename,
        task.revision.as_deref(),
        task.sha256.as_deref(),
    );
    if !policy.allowed {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Download blocked by policy requirements",
                "requires_consent": false,
                "warnings": policy.warnings,
            })),
        )
            .into_response());
    }
    if policy.requires_consent && !consent {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Download requires confirmation",
                "success": false,
                "requires_consent": true,
                "warnings": policy.warnings
            })),
        )
            .into_response());
    }

    let job_id = Uuid::new_v4().to_string();
    state.core().setup.set_job_id(Some(job_id.clone()))?;
    state
        .core()
        .setup
        .update_progress("pending", 0.0, "Starting download...")?;

    let state_clone = state.clone();
    tokio::spawn(run_download_job(state_clone, vec![task]));

    Ok(Json(json!({"success": true, "job_id": job_id})).into_response())
}

pub fn register_local_model(
    state: &AppStateWrite,
    path: &str,
    modality: &str,
    display_name: Option<&str>,
) -> Result<String, ApiError> {
    let path = Path::new(path);
    let filename = path.file_name().and_then(|v| v.to_str()).unwrap_or("model");
    let display_name = display_name
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("Local: {}", filename));
    let entry = state
        .ai()
        .models
        .register_local_model(path, modality, &display_name)?;
    Ok(entry.id)
}

pub fn delete_model(state: &AppStateWrite, model_id: &str) -> Result<(), ApiError> {
    let success = state.ai().models.delete_model(model_id)?;
    if !success {
        return Err(ApiError::NotFound("Model not found".to_string()));
    }
    Ok(())
}

pub async fn refresh_ollama_models(state: &AppStateWrite) -> Result<usize, ApiError> {
    state.ai().models.refresh_ollama_models().await
}

pub async fn refresh_lmstudio_models(state: &AppStateWrite) -> Result<usize, ApiError> {
    state.ai().models.refresh_lmstudio_models().await
}

pub async fn check_model_update(
    state: &AppStateRead,
    target: ModelUpdateCheckTarget<'_>,
) -> Result<Value, ApiError> {
    match target {
        ModelUpdateCheckTarget::ModelId(model_id) => {
            let registry = state.ai().models.get_registry()?;
            if let Some(entry) = registry.models.iter().find(|m| m.id == model_id) {
                if let Some(repo_id) = entry.repo_id.as_ref() {
                    let result = state
                        .ai()
                        .models
                        .check_update(
                            repo_id,
                            &entry.filename,
                            entry.revision.as_deref(),
                            entry.sha256.as_deref(),
                            Some(entry.file_size),
                        )
                        .await?;
                    return Ok(normalize_model_update_check_response(
                        &result,
                        entry.revision.as_deref(),
                        entry.sha256.as_deref(),
                        Some(entry.file_size),
                    ));
                }
            }
            Err(ApiError::NotFound("Model not found".to_string()))
        }
        ModelUpdateCheckTarget::RepoFile {
            repo_id,
            filename,
            revision,
        } => {
            let result = state
                .ai()
                .models
                .check_update(repo_id, filename, revision, None, None)
                .await?;
            Ok(normalize_model_update_check_response(
                &result, revision, None, None,
            ))
        }
    }
}
