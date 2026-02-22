use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tar::Archive;
use uuid::Uuid;
use zip::ZipArchive;

use super::utils::{ensure_object_path, resolve_model_path};
use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::state::{AppState, AppStateRead, AppStateWrite};

#[derive(Debug, Deserialize)]
pub struct SetupInitRequest {
    pub language: String,
}

#[derive(Debug, Deserialize)]
pub struct SetupPreflightRequest {
    #[serde(default)]
    pub required_space_mb: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SetupRunRequest {
    #[serde(default)]
    pub target_models: Option<Vec<Value>>,
    #[serde(default)]
    pub acknowledge_warnings: Option<bool>,
    #[serde(default)]
    pub loader: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModelDownloadSpec {
    pub repo_id: String,
    pub filename: String,
    pub role: String,
    pub display_name: String,
    pub revision: Option<String>,
    pub sha256: Option<String>,
}

impl ModelDownloadSpec {
    fn role_key(&self) -> String {
        let lower = self.role.to_lowercase();
        if lower == "embedding" {
            "embedding".to_string()
        } else {
            "character".to_string()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SetupFinishRequest {
    #[serde(default)]
    #[allow(dead_code)]
    pub launch: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ModelRoleRequest {
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ProfessionalRoleRequest {
    pub task_type: String,
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ActiveModelRequest {
    pub model_id: String,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReorderModelsRequest {
    #[serde(default)]
    pub role: Option<String>,
    pub model_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckModelRequest {
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DownloadModelRequest {
    pub repo_id: String,
    pub filename: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub acknowledge_warnings: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct LocalModelRequest {
    #[serde(alias = "file_path")]
    pub path: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ModelUpdateCheckTarget<'a> {
    ModelId(&'a str),
    RepoFile {
        repo_id: &'a str,
        filename: &'a str,
        revision: Option<&'a str>,
    },
}

#[derive(Debug, Deserialize)]
pub struct BinaryUpdateRequest {
    pub variant: Option<String>,
}

pub async fn setup_init(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<SetupInitRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.setup.set_language(payload.language.clone())?;
    Ok(Json(json!({"success": true, "language": payload.language})))
}

pub async fn setup_preflight(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
    Json(payload): Json<SetupPreflightRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let test_path = state.paths.user_data_dir.join(".write_test");
    let write_ok = fs::write(&test_path, b"test").is_ok();
    if write_ok {
        let _ = fs::remove_file(&test_path);
    }
    if !write_ok {
        return Ok(Json(json!({
            "success": false,
            "error": "Write permission denied for user data directory."
        })));
    }

    let available = fs2::available_space(&state.paths.user_data_dir).unwrap_or(0);
    let available_mb = available / (1024 * 1024);
    if let Some(required) = payload.required_space_mb {
        if available_mb < required as u64 {
            return Ok(Json(json!({
                "success": false,
                "error": format!("Insufficient disk space. Required: {}MB, Available: {}MB", required, available_mb)
            })));
        }
    }

    Ok(Json(json!({"success": true, "available_mb": available_mb})))
}

pub async fn setup_requirements(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let text_path = config
        .get("models_gguf")
        .and_then(|v| v.get("text_model"))
        .and_then(|v| v.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| resolve_model_path(s, &state.paths));
    let embedding_path = config
        .get("models_gguf")
        .and_then(|v| v.get("embedding_model"))
        .and_then(|v| v.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| resolve_model_path(s, &state.paths));

    let text_ok = text_path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let embedding_ok = embedding_path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let has_missing = !(text_ok && embedding_ok);

    Ok(Json(json!({
        "is_ready": text_ok && embedding_ok,
        "has_missing": has_missing,
        "binary": {"status": "ok", "version": null},
        "models": {
            "text": {"status": if text_ok { "ok" } else { "missing" }, "name": text_path.map(|p| p.to_string_lossy().to_string())},
            "embedding": {"status": if embedding_ok { "ok" } else { "missing" }, "name": embedding_path.map(|p| p.to_string_lossy().to_string())}
        }
    })))
}

pub async fn setup_default_models(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let defaults = config.get("default_models").cloned().unwrap_or(json!({}));
    let mut text_models = defaults
        .get("text_models")
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    if text_models
        .as_array()
        .map(|arr| arr.is_empty())
        .unwrap_or(true)
    {
        let mut fallback = Vec::new();
        for key in ["character", "executor", "text"] {
            if let Some(model) = defaults.get(key) {
                fallback.push(model.clone());
            }
        }
        text_models = Value::Array(fallback);
    }
    let embedding = defaults.get("embedding").cloned().unwrap_or(Value::Null);
    Ok(Json(
        json!({"text_models": text_models, "embedding": embedding}),
    ))
}

pub async fn setup_run(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<SetupRunRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let job_id = Uuid::new_v4().to_string();
    state.setup.set_job_id(Some(job_id.clone()))?;
    state
        .setup
        .update_progress("pending", 0.0, "Starting setup...")?;
    if let Some(loader) = payload.loader.clone() {
        state.setup.set_loader(loader)?;
    }

    let config_snapshot = state.config.load_config()?;
    let mut target_models = build_target_models(payload.target_models, &config_snapshot);
    if payload.loader.as_deref() == Some("ollama") {
        target_models.retain(|model| model.role.to_lowercase() == "embedding");
    }

    let mut warnings = Vec::new();
    for model in &target_models {
        let policy = state.models.evaluate_download_policy(
            &model.repo_id,
            &model.filename,
            model.revision.as_deref(),
            model.sha256.as_deref(),
        );
        if !policy.allowed {
            return Ok(Json(json!({
                "success": false,
                "requires_consent": false,
                "warnings": policy.warnings
            })));
        }
        if policy.requires_consent {
            warnings.push(json!({
                "repo_id": model.repo_id,
                "filename": model.filename,
                "revision": model.revision.clone(),
                "warnings": policy.warnings,
            }));
        }
    }

    if !warnings.is_empty() && payload.acknowledge_warnings != Some(true) {
        state.setup.set_job_id(None)?;
        return Ok(Json(json!({
            "success": false,
            "requires_consent": true,
            "warnings": warnings
        })));
    }

    let state_clone = state.clone();
    tokio::spawn(async move {
        let total = target_models.len().max(1) as f32;
        for (idx, model) in target_models.into_iter().enumerate() {
            let base_progress = idx as f32 / total;
            let progress_cb = |p: f32, message: &str| {
                let _ = state_clone.setup.update_progress(
                    "downloading",
                    base_progress + (p / total),
                    message,
                );
            };

            let result = state_clone
                .models
                .download_from_huggingface(
                    &model.repo_id,
                    &model.filename,
                    &model.role,
                    &model.display_name,
                    model.revision.as_deref(),
                    model.sha256.as_deref(),
                    payload.acknowledge_warnings.unwrap_or(false),
                    Some(&progress_cb),
                )
                .await;

            if let Ok(result) = result {
                if result.success {
                    if let Some(model_id) = result.model_id.as_deref() {
                        let role_key = model.role_key();
                        let assignment = state_clone.models.set_role_model(&role_key, model_id);
                        if assignment.as_ref().is_ok_and(|assigned| *assigned) {
                            let _ = state_clone
                                .models
                                .update_active_model_config(&role_key, model_id);
                        } else if let Err(err) = assignment {
                            tracing::warn!(
                                model_id = %model_id,
                                role = %role_key,
                                error = %err,
                                "Failed to assign downloaded model to role"
                            );
                        }
                    }
                } else {
                    let _ = state_clone
                        .setup
                        .update_progress("failed", 0.0, "Setup failed");
                    let _ = state_clone.setup.set_job_id(None);
                    return;
                }
            } else {
                let _ = state_clone
                    .setup
                    .update_progress("failed", 0.0, "Setup failed");
                let _ = state_clone.setup.set_job_id(None);
                return;
            }
        }

        let _ =
            state_clone
                .setup
                .update_progress("completed", 1.0, "Setup completed successfully!");
        let _ = state_clone.setup.set_job_id(None);
    });

    Ok(Json(json!({"success": true, "job_id": job_id})))
}

pub async fn setup_progress(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let snapshot = state.setup.snapshot()?;
    Ok(Json(json!(snapshot.progress)))
}

pub async fn setup_finish(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(_payload): Json<SetupFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let snapshot = state.setup.snapshot()?;
    let mut config = state.config.load_config()?;
    ensure_object_path(&mut config, &["app", "setup_completed"], Value::Bool(true));
    ensure_object_path(
        &mut config,
        &["app", "language"],
        Value::String(snapshot.language),
    );
    ensure_object_path(
        &mut config,
        &["llm_manager", "loader"],
        Value::String(snapshot.loader),
    );
    state.config.update_config(config, true)?;
    state.setup.clear()?;
    Ok(Json(json!({"success": true})))
}

pub async fn setup_models(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let models = state.models.list_models()?;
    let config = state.config.load_config().unwrap_or(Value::Null);
    let active_character = config.get("active_agent_profile").and_then(|v| v.as_str());
    let active_text = state.models.resolve_character_model_id(active_character)?;
    let active_embedding = state.models.resolve_embedding_model_id()?;
    let payload: Vec<Value> = models
        .into_iter()
        .map(|model| {
            let is_active = if model.role == "embedding" {
                active_embedding.as_deref() == Some(&model.id)
            } else {
                active_text.as_deref() == Some(&model.id)
            };
            json!({
                "id": model.id,
                "display_name": model.display_name,
                "role": model.role,
                "file_size": model.file_size,
                "filename": model.filename,
                "file_path": model.file_path,
                "source": model.source,
                "loader": model.loader,
                "is_active": is_active,
            })
        })
        .collect();
    Ok(Json(json!({"models": payload})))
}

pub async fn setup_model_roles(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let registry = state.models.get_registry()?;
    let character_model_id = registry.role_assignments.get("character").cloned();
    let mut character_map = Map::new();
    let mut agent_map = Map::new();
    let mut professional_map = Map::new();
    for (key, value) in registry.role_assignments.iter() {
        if key == "professional" {
            professional_map.insert("default".to_string(), Value::String(value.clone()));
        } else if let Some(character) = key.strip_prefix("character:") {
            character_map.insert(character.to_string(), Value::String(value.clone()));
        } else if let Some(agent) = key.strip_prefix("agent:") {
            agent_map.insert(agent.to_string(), Value::String(value.clone()));
        } else if let Some(task) = key.strip_prefix("professional:") {
            professional_map.insert(task.to_string(), Value::String(value.clone()));
        }
    }
    Ok(Json(json!({
        "character_model_id": character_model_id,
        "character_model_map": character_map,
        "agent_model_map": agent_map,
        "professional_model_map": professional_map
    })))
}

pub async fn setup_set_character_role(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<ModelRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let ok = state
        .models
        .set_role_model("character", &payload.model_id)
        .map_err(|e| {
            tracing::warn!(model_id = %payload.model_id, error = %e, "Failed to set character role");
            ApiError::BadRequest(format!(
                "Failed to set character role for model '{}': {}",
                payload.model_id, e
            ))
        })?;
    if ok {
        state
            .models
            .update_active_model_config("text", &payload.model_id)
            .map_err(|e| {
                tracing::warn!(model_id = %payload.model_id, error = %e, "Failed to update active model config");
                ApiError::BadRequest(format!(
                    "Failed to activate model '{}': {}",
                    payload.model_id, e
                ))
            })?;
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound(format!(
        "Model '{}' not found in registry",
        payload.model_id
    )))
}

pub async fn setup_set_professional_role(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<ProfessionalRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let role_key = if payload.task_type == "default" {
        "professional".to_string()
    } else {
        format!("professional:{}", payload.task_type)
    };
    let ok = state.models.set_role_model(&role_key, &payload.model_id)?;
    if ok {
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Model not found".to_string()))
}

pub async fn setup_set_character_specific_role(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
    Json(payload): Json<ModelRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let character_id = normalized_assignment_subject(&character_id)
        .ok_or_else(|| ApiError::BadRequest("character_id is required".to_string()))?;
    let role_key = format!("character:{}", character_id);
    let ok = state.models.set_role_model(&role_key, &payload.model_id)?;
    if ok {
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Model not found".to_string()))
}

pub async fn setup_delete_character_specific_role(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(character_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let character_id = normalized_assignment_subject(&character_id)
        .ok_or_else(|| ApiError::BadRequest("character_id is required".to_string()))?;
    let role_key = format!("character:{}", character_id);
    let ok = state.models.remove_role_assignment(&role_key)?;
    if ok {
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Role assignment not found".to_string()))
}

pub async fn setup_set_agent_role(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(payload): Json<ModelRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let agent_id = normalized_assignment_subject(&agent_id)
        .ok_or_else(|| ApiError::BadRequest("agent_id is required".to_string()))?;
    let role_key = format!("agent:{}", agent_id);
    let ok = state.models.set_role_model(&role_key, &payload.model_id)?;
    if ok {
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Model not found".to_string()))
}

pub async fn setup_delete_agent_role(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let agent_id = normalized_assignment_subject(&agent_id)
        .ok_or_else(|| ApiError::BadRequest("agent_id is required".to_string()))?;
    let role_key = format!("agent:{}", agent_id);
    let ok = state.models.remove_role_assignment(&role_key)?;
    if ok {
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Role assignment not found".to_string()))
}

pub async fn setup_delete_professional_role(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(task_type): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let role_key = if task_type == "default" {
        "professional".to_string()
    } else {
        format!("professional:{}", task_type)
    };
    let ok = state.models.remove_role_assignment(&role_key)?;
    if ok {
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Role assignment not found".to_string()))
}

pub async fn setup_set_active_model(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<ActiveModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let requested_role = payload
        .role
        .as_deref()
        .unwrap_or("text")
        .to_ascii_lowercase();
    let (role_key, config_role) = if requested_role == "embedding" {
        ("embedding", "embedding")
    } else {
        ("character", "text")
    };

    let assigned = state
        .models
        .set_role_model(role_key, &payload.model_id)
        .map_err(|e| {
            tracing::warn!(
                model_id = %payload.model_id,
                role = %role_key,
                error = %e,
                "Failed to set active role assignment"
            );
            ApiError::BadRequest(format!(
                "Failed to set '{}' role for model '{}': {}",
                role_key, payload.model_id, e
            ))
        })?;
    if !assigned {
        return Err(ApiError::NotFound(format!(
            "Model '{}' not found in registry",
            payload.model_id
        )));
    }

    state
        .models
        .update_active_model_config(config_role, &payload.model_id)
        .map_err(|e| {
            tracing::warn!(
                model_id = %payload.model_id,
                role = %config_role,
                error = %e,
                "Failed to set active model"
            );
            match e {
                ApiError::NotFound(_) => ApiError::NotFound(format!(
                    "Model '{}' not found in registry",
                    payload.model_id
                )),
                ApiError::BadRequest(msg) => ApiError::BadRequest(format!(
                    "Failed to activate model '{}': {}",
                    payload.model_id, msg
                )),
                ApiError::Conflict(msg) => ApiError::Conflict(format!(
                    "Failed to activate model '{}': {}",
                    payload.model_id, msg
                )),
                ApiError::Internal(msg) => ApiError::Internal(format!(
                    "Failed to activate model '{}': {}",
                    payload.model_id, msg
                )),
                other => other,
            }
        })?;
    Ok(Json(json!({"success": true})))
}

pub async fn setup_reorder_models(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<ReorderModelsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let role = payload
        .role
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("text");
    let normalized_role = if role.eq_ignore_ascii_case("embedding") {
        "embedding"
    } else {
        "text"
    };
    state
        .models
        .reorder_models(normalized_role, payload.model_ids)?;
    Ok(Json(json!({"success": true})))
}

pub async fn setup_check_model(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
    Json(payload): Json<CheckModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    // C-1 fix: model_id がある場合は既存のモデル検索、なければ repo_id/filename で存在確認
    if let Some(model_id) = &payload.model_id {
        let details = state.models.get_model(model_id)?;
        return Ok(Json(
            json!({ "exists": details.is_some(), "model": details }),
        ));
    }

    if let (Some(repo_id), Some(filename)) = (&payload.repo_id, &payload.filename) {
        // リモートファイルのサイズ取得で存在確認
        let size = state.models.get_remote_file_size(repo_id, filename).await?;
        return Ok(Json(json!({ "exists": size.is_some(), "size": size })));
    }

    Err(ApiError::BadRequest(
        "model_id or repo_id+filename required".to_string(),
    ))
}

pub async fn setup_download_model(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<DownloadModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    // C-1 fix: 単一モデルダウンロードの本実装
    let role = payload.role.as_deref().unwrap_or("text");
    let consent = payload.acknowledge_warnings.unwrap_or(false);
    let display_name = payload.filename.clone();

    // ポリシー確認
    let policy =
        state
            .models
            .evaluate_download_policy(&payload.repo_id, &payload.filename, None, None);
    if !policy.allowed {
        return Ok(Json(json!({
            "success": false,
            "requires_consent": false,
            "warnings": policy.warnings
        })));
    }
    if policy.requires_consent && !consent {
        return Err(ApiError::Conflict(
            json!({
                "success": false,
                "requires_consent": true,
                "warnings": policy.warnings
            })
            .to_string(),
        ));
    }

    // 非同期ダウンロード開始
    let job_id = uuid::Uuid::new_v4().to_string();
    state.setup.set_job_id(Some(job_id.clone()))?;
    state
        .setup
        .update_progress("pending", 0.0, "Starting download...")?;

    let state_clone = state.clone();
    let repo_id = payload.repo_id.clone();
    let filename = payload.filename.clone();
    let role_owned = role.to_string();

    tokio::spawn(async move {
        let result = state_clone
            .models
            .download_from_huggingface(
                &repo_id,
                &filename,
                &role_owned,
                &display_name,
                None,
                None,
                consent,
                Some(&|p: f32, msg: &str| {
                    let _ = state_clone.setup.update_progress("downloading", p, msg);
                }),
            )
            .await;

        match result {
            Ok(dl_result) if dl_result.success => {
                if let Some(model_id) = dl_result.model_id.as_deref() {
                    let role_key = if role_owned == "embedding" {
                        "embedding"
                    } else {
                        "character"
                    };
                    let assignment = state_clone.models.set_role_model(role_key, model_id);
                    if assignment.as_ref().is_ok_and(|assigned| *assigned) {
                        let _ = state_clone.models.update_active_model_config(
                            if role_owned == "embedding" {
                                "embedding"
                            } else {
                                "text"
                            },
                            model_id,
                        );
                    } else if let Err(err) = assignment {
                        tracing::warn!(
                            model_id = %model_id,
                            role = %role_key,
                            error = %err,
                            "Failed to assign downloaded model to role"
                        );
                    }
                }
                let _ = state_clone
                    .setup
                    .update_progress("completed", 1.0, "Download completed!");
            }
            _ => {
                let _ = state_clone
                    .setup
                    .update_progress("failed", 0.0, "Download failed");
            }
        }
        let _ = state_clone.setup.set_job_id(None);
    });

    Ok(Json(json!({"success": true, "job_id": job_id})))
}

pub async fn setup_register_local_model(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<LocalModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let path = std::path::Path::new(&payload.path);
    let filename = path.file_name().and_then(|v| v.to_str()).unwrap_or("model");
    // C-1 fix: フロントから送られる role / display_name を反映
    let role = payload.role.as_deref().unwrap_or("text");
    let display_name = payload
        .display_name
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Local: {}", filename));
    let entry = state
        .models
        .register_local_model(path, role, &display_name)?;
    Ok(Json(json!({"success": true, "model_id": entry.id})))
}

pub async fn setup_delete_model(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(model_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let success = state.models.delete_model(&model_id)?;
    if !success {
        return Err(ApiError::NotFound("Model not found".to_string()));
    }
    Ok(Json(json!({"success": true})))
}

pub async fn setup_refresh_ollama_models(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let count = state.models.refresh_ollama_models().await?;
    Ok(Json(json!({"success": true, "count": count})))
}

pub async fn setup_refresh_lmstudio_models(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let count = state.models.refresh_lmstudio_models().await?;
    Ok(Json(json!({"success": true, "count": count})))
}

pub async fn setup_model_update_check(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    match parse_model_update_check_target(&params)? {
        ModelUpdateCheckTarget::ModelId(model_id) => {
            let registry = state.models.get_registry()?;
            if let Some(entry) = registry.models.iter().find(|m| m.id == model_id) {
                if let Some(repo_id) = entry.repo_id.as_ref() {
                    let result = state
                        .models
                        .check_update(
                            repo_id,
                            &entry.filename,
                            entry.revision.as_deref(),
                            entry.sha256.as_deref(),
                            Some(entry.file_size),
                        )
                        .await?;
                    return Ok(Json(result));
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
                .models
                .check_update(repo_id, filename, revision, None, None)
                .await?;
            Ok(Json(result))
        }
    }
}

pub async fn setup_binary_update_info(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let requested_variant = normalize_binary_variant(
        params
            .get("variant")
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty()),
    );
    let release = fetch_latest_llama_release().await?;
    let current_version = current_binary_version_snapshot(&state.paths);
    let has_update = select_release_asset(&release, &requested_variant)
        .map(|_| is_newer_llama_release(current_version.as_deref(), &release.tag_name))
        .unwrap_or(false);

    Ok(Json(json!({
        "has_update": has_update,
        "current_version": current_version.unwrap_or_else(|| "unknown".to_string()),
        "latest_version": if has_update { Some(release.tag_name) } else { None },
        "release_notes": release.body,
    })))
}

pub async fn setup_binary_update(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<BinaryUpdateRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let requested_variant = normalize_binary_variant(payload.variant.as_deref());
    let job_id = Uuid::new_v4().to_string();
    state.setup.set_job_id(Some(job_id.clone()))?;
    state
        .setup
        .update_progress("pending", 0.0, "Starting binary update...")?;

    let state_clone = state.clone();
    tokio::spawn(async move {
        let result = install_latest_llama_binary(state_clone.shared(), &requested_variant).await;
        match result {
            Ok(version) => {
                let _ = state_clone.setup.update_progress(
                    "completed",
                    1.0,
                    &format!("Updated llama.cpp binary to {}", version),
                );
            }
            Err(err) => {
                let _ = state_clone.setup.update_progress(
                    "failed",
                    0.0,
                    &format!("Update failed: {}", err),
                );
            }
        }
        let _ = state_clone.setup.set_job_id(None);
    });

    Ok(Json(json!({"success": true, "job_id": job_id})))
}

// ----- Helpers below -----

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
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("text")
                .to_string();
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
                role,
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
                role: "text".to_string(),
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
                role: "embedding".to_string(),
                display_name,
                revision,
                sha256,
            });
        }
    }
    specs
}

fn normalized_assignment_subject(value: &str) -> Option<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.to_string())
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

const LLAMA_RELEASE_LATEST_URL: &str =
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const LLAMA_RELEASE_USER_AGENT: &str = "tepora-backend-rs";

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct BinaryInstallRegistry {
    #[serde(default)]
    current_version: Option<String>,
    #[serde(default)]
    current_variant: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

fn binary_root_dir(paths: &crate::core::config::AppPaths) -> PathBuf {
    paths.user_data_dir.join("bin").join("llama.cpp")
}

fn binary_current_dir(paths: &crate::core::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("current")
}

fn binary_download_dir(paths: &crate::core::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("downloads")
}

fn binary_tmp_dir(paths: &crate::core::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("tmp")
}

fn binary_registry_path(paths: &crate::core::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("binary_registry.json")
}

fn load_binary_registry(paths: &crate::core::config::AppPaths) -> BinaryInstallRegistry {
    let path = binary_registry_path(paths);
    let Ok(contents) = fs::read_to_string(path) else {
        return BinaryInstallRegistry::default();
    };
    serde_json::from_str::<BinaryInstallRegistry>(&contents).unwrap_or_default()
}

fn save_binary_registry(
    paths: &crate::core::config::AppPaths,
    registry: &BinaryInstallRegistry,
) -> Result<(), ApiError> {
    let path = binary_registry_path(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(ApiError::internal)?;
    }
    let serialized = serde_json::to_string_pretty(registry).map_err(ApiError::internal)?;
    fs::write(path, serialized).map_err(ApiError::internal)
}

fn current_binary_version_snapshot(paths: &crate::core::config::AppPaths) -> Option<String> {
    let registry = load_binary_registry(paths);
    let current = registry
        .current_version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if current.is_some() {
        return current;
    }
    let current_dir = binary_current_dir(paths);
    if find_llama_server_executable(&current_dir).is_some() {
        return Some("installed".to_string());
    }
    None
}

fn normalize_binary_variant(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("auto").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "auto" | "cuda-12.4" | "cuda-11.8" | "vulkan" | "cpu-avx2" | "cpu-avx" | "cpu-sse42"
        | "metal" => normalized,
        _ => "auto".to_string(),
    }
}

fn resolve_binary_variant(normalized_variant: &str) -> String {
    if normalized_variant == "auto" {
        if cfg!(target_os = "macos") {
            "metal".to_string()
        } else {
            "cpu-avx2".to_string()
        }
    } else {
        normalized_variant.to_string()
    }
}

fn release_asset_patterns(normalized_variant: &str) -> Vec<String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match os {
        "macos" => match normalized_variant {
            "metal" | "auto" => {
                if arch == "aarch64" {
                    vec!["macos-arm64.tar.gz".to_string()]
                } else {
                    vec!["macos-x64.tar.gz".to_string()]
                }
            }
            _ => vec!["macos-x64.tar.gz".to_string()],
        },
        "windows" => match normalized_variant {
            "cuda-12.4" => vec!["win-cuda-12.4-x64.zip".to_string()],
            "cuda-11.8" => vec!["win-cuda-cu11".to_string(), "win-cuda-11.".to_string()],
            "vulkan" => vec!["win-vulkan-x64.zip".to_string()],
            "cpu-avx2" | "cpu-avx" | "cpu-sse42" => vec!["win-cpu-x64.zip".to_string()],
            _ => {
                if arch == "aarch64" {
                    vec!["win-cpu-arm64.zip".to_string()]
                } else {
                    vec!["win-cpu-x64.zip".to_string()]
                }
            }
        },
        _ => match normalized_variant {
            "cuda-12.4" => vec!["linux-cuda-12.4-x64.tar.gz".to_string()],
            "cuda-11.8" => vec!["linux-cuda-11.".to_string()],
            "vulkan" => vec!["ubuntu-vulkan-x64.tar.gz".to_string()],
            _ => {
                if arch == "aarch64" {
                    vec![
                        "ubuntu-arm64.tar.gz".to_string(),
                        "ubuntu-x64.tar.gz".to_string(),
                        "ubuntu-22.04-arm64.tar.gz".to_string(), // fallback similar to logic
                    ]
                } else {
                    vec![
                        "ubuntu-x64.tar.gz".to_string(),
                        "ubuntu-22.04-x64.tar.gz".to_string(),
                    ]
                }
            }
        },
    }
}

fn select_release_asset(
    release: &GithubRelease,
    requested_variant: &str,
) -> Option<(String, GithubReleaseAsset)> {
    let normalized_variant = normalize_binary_variant(Some(requested_variant));
    let patterns = release_asset_patterns(&normalized_variant);
    for asset in &release.assets {
        let name = asset.name.to_ascii_lowercase();
        if patterns.iter().any(|pattern| name.contains(pattern)) {
            return Some((resolve_binary_variant(&normalized_variant), asset.clone()));
        }
    }
    None
}

fn parse_llama_build_number(version: &str) -> Option<u64> {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return None;
    }
    let number = trimmed
        .strip_prefix('b')
        .or_else(|| trimmed.strip_prefix('B'))
        .unwrap_or(trimmed);
    if number.chars().all(|c| c.is_ascii_digit()) {
        return number.parse::<u64>().ok();
    }
    None
}

fn is_newer_llama_release(current: Option<&str>, latest: &str) -> bool {
    let latest_num = parse_llama_build_number(latest);
    let current_num = current.and_then(parse_llama_build_number);
    match (current_num, latest_num) {
        (Some(current), Some(latest)) => latest > current,
        _ => current
            .map(|value| value.trim() != latest.trim())
            .unwrap_or(true),
    }
}

fn parse_sha256_digest(digest: Option<&str>) -> Option<String> {
    let raw = digest?.trim();
    if let Some(value) = raw.strip_prefix("sha256:") {
        return normalize_sha256_hex(value);
    }
    normalize_sha256_hex(raw)
}

fn normalize_sha256_hex(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() == 64 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Some(normalized);
    }
    None
}

async fn fetch_latest_llama_release() -> Result<GithubRelease, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(ApiError::internal)?;
    let response = client
        .get(LLAMA_RELEASE_LATEST_URL)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::USER_AGENT, LLAMA_RELEASE_USER_AGENT)
        .send()
        .await
        .map_err(ApiError::internal)?
        .error_for_status()
        .map_err(ApiError::internal)?;
    response
        .json::<GithubRelease>()
        .await
        .map_err(ApiError::internal)
}

async fn download_release_asset(
    asset: &GithubReleaseAsset,
    target_path: &FsPath,
    mut progress_cb: impl FnMut(f32, &str),
) -> Result<String, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(ApiError::internal)?;
    let response = client
        .get(&asset.browser_download_url)
        .header(header::ACCEPT, "application/octet-stream")
        .header(header::USER_AGENT, LLAMA_RELEASE_USER_AGENT)
        .send()
        .await
        .map_err(ApiError::internal)?
        .error_for_status()
        .map_err(ApiError::internal)?;

    let total = response.content_length().or(asset.size).unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(target_path).map_err(ApiError::internal)?;
    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();

    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(ApiError::internal)?;
        file.write_all(&data).map_err(ApiError::internal)?;
        hasher.update(&data);
        downloaded += data.len() as u64;
        let progress = if total > 0 {
            downloaded as f32 / total as f32
        } else {
            0.0
        };
        let message = if total > 0 {
            format!(
                "Downloading binary... {:.1} MB / {:.1} MB",
                downloaded as f64 / (1024_f64 * 1024_f64),
                total as f64 / (1024_f64 * 1024_f64)
            )
        } else {
            "Downloading binary...".to_string()
        };
        progress_cb(progress, &message);
    }

    Ok(hex::encode(hasher.finalize()))
}

fn normalize_archive_member_path(raw: &FsPath) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    if normalized.as_os_str().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn extract_zip_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    let file = fs::File::open(archive_path).map_err(ApiError::internal)?;
    let mut zip = ZipArchive::new(file).map_err(ApiError::internal)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(ApiError::internal)?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(ApiError::BadRequest(format!(
                "Unsafe archive entry: {}",
                entry.name()
            )));
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(ApiError::internal)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(ApiError::internal)?;
            }
            let mut outfile = fs::File::create(&target).map_err(ApiError::internal)?;
            std::io::copy(&mut entry, &mut outfile).map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

fn extract_tar_gz_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    let file = fs::File::open(archive_path).map_err(ApiError::internal)?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    for item in archive.entries().map_err(ApiError::internal)? {
        let mut entry = item.map_err(ApiError::internal)?;
        let raw_path = entry.path().map_err(ApiError::internal)?.into_owned();
        let Some(relative) = normalize_archive_member_path(&raw_path) else {
            return Err(ApiError::BadRequest(format!(
                "Unsafe archive entry: {}",
                raw_path.to_string_lossy()
            )));
        };
        let target = destination.join(relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(ApiError::BadRequest(
                "Unsupported archive symlink entry".to_string(),
            ));
        }
        if entry_type.is_dir() {
            fs::create_dir_all(&target).map_err(ApiError::internal)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(ApiError::internal)?;
        }
        entry.unpack(&target).map_err(ApiError::internal)?;
    }
    Ok(())
}

fn find_llama_server_executable(root: &FsPath) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    if !root.exists() {
        return None;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some(exe_name) {
                return Some(path);
            }
        }
    }
    None
}

fn copy_dir_recursive(source: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    fs::create_dir_all(destination).map_err(ApiError::internal)?;
    for item in fs::read_dir(source).map_err(ApiError::internal)? {
        let entry = item.map_err(ApiError::internal)?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(ApiError::internal)?;
            }
            fs::copy(&source_path, &destination_path).map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

fn replace_current_binary_dir(source: &FsPath, current_dir: &FsPath) -> Result<(), ApiError> {
    if current_dir.exists() {
        fs::remove_dir_all(current_dir).map_err(ApiError::internal)?;
    }

    match fs::rename(source, current_dir) {
        Ok(_) => Ok(()),
        Err(_) => {
            copy_dir_recursive(source, current_dir)?;
            fs::remove_dir_all(source).map_err(ApiError::internal)?;
            Ok(())
        }
    }
}

fn is_zip_archive(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().ends_with(".zip"))
        .unwrap_or(false)
}

fn is_tar_gz_archive(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".tar.gz") || lower.ends_with(".tgz")
        })
        .unwrap_or(false)
}

fn extract_binary_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    if is_zip_archive(archive_path) {
        return extract_zip_archive(archive_path, destination);
    }
    if is_tar_gz_archive(archive_path) {
        return extract_tar_gz_archive(archive_path, destination);
    }
    Err(ApiError::BadRequest(format!(
        "Unsupported archive format: {}",
        archive_path.display()
    )))
}

async fn install_latest_llama_binary(
    state: Arc<AppState>,
    requested_variant: &str,
) -> Result<String, ApiError> {
    state
        .setup
        .update_progress("pending", 0.05, "Checking latest llama.cpp release...")?;
    let release = fetch_latest_llama_release().await?;
    let (resolved_variant, asset) =
        select_release_asset(&release, requested_variant).ok_or_else(|| {
            ApiError::NotFound(format!(
                "No matching release asset found for variant '{}'",
                requested_variant
            ))
        })?;

    let install_root = binary_root_dir(&state.paths);
    let downloads_dir = binary_download_dir(&state.paths);
    let tmp_dir = binary_tmp_dir(&state.paths);
    fs::create_dir_all(&downloads_dir).map_err(ApiError::internal)?;
    fs::create_dir_all(&tmp_dir).map_err(ApiError::internal)?;

    let archive_name = FsPath::new(&asset.name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("llama-release.bin")
        .to_string();
    let archive_path = downloads_dir.join(&archive_name);
    let partial_path = downloads_dir.join(format!("{}.part", archive_name));

    let state_for_progress = state.clone();
    let downloaded_sha = download_release_asset(&asset, &partial_path, move |progress, message| {
        let stage_progress = 0.1 + (progress * 0.6);
        let _ = state_for_progress
            .setup
            .update_progress("downloading", stage_progress, message);
    })
    .await?;

    if archive_path.exists() {
        let _ = fs::remove_file(&archive_path);
    }
    fs::rename(&partial_path, &archive_path).map_err(ApiError::internal)?;

    state
        .setup
        .update_progress("verifying", 0.75, "Verifying SHA256 digest...")?;
    let expected_sha = parse_sha256_digest(asset.digest.as_deref()).ok_or_else(|| {
        ApiError::BadRequest("Release asset is missing a valid SHA256 digest".to_string())
    })?;
    if downloaded_sha != expected_sha {
        let _ = fs::remove_file(&archive_path);
        return Err(ApiError::BadRequest(
            "SHA256 verification failed for downloaded binary".to_string(),
        ));
    }

    state
        .setup
        .update_progress("extracting", 0.82, "Extracting archive...")?;
    let extract_dir = tmp_dir.join(format!("extract_{}", Uuid::new_v4()));
    if extract_dir.exists() {
        let _ = fs::remove_dir_all(&extract_dir);
    }
    fs::create_dir_all(&extract_dir).map_err(ApiError::internal)?;
    extract_binary_archive(&archive_path, &extract_dir)?;
    let _ = fs::remove_file(&archive_path);

    let current_dir = binary_current_dir(&state.paths);
    state
        .setup
        .update_progress("extracting", 0.92, "Installing binary files...")?;
    replace_current_binary_dir(&extract_dir, &current_dir)?;

    if find_llama_server_executable(&current_dir).is_none() {
        return Err(ApiError::Internal(
            "Installed archive does not contain llama-server executable".to_string(),
        ));
    }

    fs::create_dir_all(&install_root).map_err(ApiError::internal)?;
    save_binary_registry(
        &state.paths,
        &BinaryInstallRegistry {
            current_version: Some(release.tag_name.clone()),
            current_variant: Some(resolved_variant),
            updated_at: Some(Utc::now().to_rfc3339()),
        },
    )?;

    state
        .setup
        .update_progress("finalizing", 0.97, "Refreshing runtime paths...")?;
    let _ = state.llama.refresh_binary_path(&state.paths).await;

    Ok(release.tag_name)
}
