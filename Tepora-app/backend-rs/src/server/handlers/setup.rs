use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::setup_binary::{fetch_binary_update_info, install_latest_llama_binary};
use super::setup_catalog::{
    check_model, check_model_update, delete_model, models_payload, queue_model_download,
    refresh_lmstudio_models, refresh_ollama_models, register_local_model, reorder_models,
};
use super::setup_flow::{
    default_models_payload, finish_setup, init_setup, preflight_payload, progress_payload,
    requirements_payload, start_setup_run,
};
use super::setup_models::{build_download_task_from_request, parse_model_update_check_target};
use super::setup_roles::{
    delete_agent_role, delete_character_specific_role, delete_professional_role,
    model_roles_payload, set_active_model, set_agent_role, set_character_role,
    set_character_specific_role, set_professional_role,
};
use crate::core::errors::ApiError;
use crate::state::{AppStateRead, AppStateWrite};

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
    pub assignment_key: String,
}

#[derive(Debug, Deserialize)]
pub struct ReorderModelsRequest {
    #[serde(default)]
    pub modality: Option<String>,
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
    pub modality: String,
    #[serde(default)]
    pub assignment_key: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub acknowledge_warnings: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct LocalModelRequest {
    #[serde(alias = "file_path")]
    pub path: String,
    pub modality: String,
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
    Json(payload): Json<SetupInitRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(init_setup(&state, &payload.language)?))
}

pub async fn setup_preflight(
    State(state): State<AppStateRead>,
    Json(payload): Json<SetupPreflightRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(preflight_payload(&state, payload.required_space_mb)?))
}

pub async fn setup_requirements(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(requirements_payload(&state)?))
}

pub async fn setup_default_models(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(default_models_payload(&state)?))
}

pub async fn setup_run(
    State(state): State<AppStateWrite>,
    Json(payload): Json<SetupRunRequest>,
) -> Result<Response, ApiError> {
    start_setup_run(
        &state,
        payload.target_models,
        payload.acknowledge_warnings,
        payload.loader,
    )
}

pub async fn setup_progress(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(progress_payload(&state)?))
}

pub async fn setup_finish(
    State(state): State<AppStateWrite>,
    Json(_payload): Json<SetupFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(finish_setup(&state)?))
}

pub async fn setup_models(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(models_payload(&state)?))
}

pub async fn setup_model_roles(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(model_roles_payload(&state)?))
}

pub async fn setup_set_character_role(
    State(state): State<AppStateWrite>,
    Json(payload): Json<ModelRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    set_character_role(&state, &payload.model_id)?;
    Ok(success_response())
}

pub async fn setup_set_professional_role(
    State(state): State<AppStateWrite>,
    Json(payload): Json<ProfessionalRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    set_professional_role(&state, &payload.task_type, &payload.model_id)?;
    Ok(success_response())
}

pub async fn setup_set_character_specific_role(
    State(state): State<AppStateWrite>,
    Path(character_id): Path<String>,
    Json(payload): Json<ModelRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    set_character_specific_role(&state, &character_id, &payload.model_id)?;
    Ok(success_response())
}

pub async fn setup_delete_character_specific_role(
    State(state): State<AppStateWrite>,
    Path(character_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    delete_character_specific_role(&state, &character_id)?;
    Ok(success_response())
}

pub async fn setup_set_agent_role(
    State(state): State<AppStateWrite>,
    Path(agent_id): Path<String>,
    Json(payload): Json<ModelRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    set_agent_role(&state, &agent_id, &payload.model_id)?;
    Ok(success_response())
}

pub async fn setup_delete_agent_role(
    State(state): State<AppStateWrite>,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    delete_agent_role(&state, &agent_id)?;
    Ok(success_response())
}

pub async fn setup_delete_professional_role(
    State(state): State<AppStateWrite>,
    Path(task_type): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    delete_professional_role(&state, &task_type)?;
    Ok(success_response())
}

pub async fn setup_set_active_model(
    State(state): State<AppStateWrite>,
    Json(payload): Json<ActiveModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    set_active_model(&state, &payload.model_id, &payload.assignment_key)?;
    Ok(success_response())
}

pub async fn setup_reorder_models(
    State(state): State<AppStateWrite>,
    Json(payload): Json<ReorderModelsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    reorder_models(&state, payload.modality.as_deref(), payload.model_ids)?;
    Ok(Json(json!({"success": true})))
}

pub async fn setup_check_model(
    State(state): State<AppStateRead>,
    Json(payload): Json<CheckModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        check_model(
            &state,
            payload.model_id.as_deref(),
            payload.repo_id.as_deref(),
            payload.filename.as_deref(),
        )
        .await?,
    ))
}

pub async fn setup_download_model(
    State(state): State<AppStateWrite>,
    Json(payload): Json<DownloadModelRequest>,
) -> Result<Response, ApiError> {
    let dl_task = build_download_task_from_request(&payload);
    queue_model_download(&state, &payload.repo_id, &payload.filename, dl_task).await
}

pub async fn setup_register_local_model(
    State(state): State<AppStateWrite>,
    Json(payload): Json<LocalModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let model_id = register_local_model(
        &state,
        &payload.path,
        &payload.modality,
        payload.display_name.as_deref(),
    )?;
    Ok(Json(json!({"success": true, "model_id": model_id})))
}

pub async fn setup_delete_model(
    State(state): State<AppStateWrite>,
    Path(model_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    delete_model(&state, &model_id)?;
    Ok(Json(json!({"success": true})))
}

pub async fn setup_refresh_ollama_models(
    State(state): State<AppStateWrite>,
) -> Result<impl IntoResponse, ApiError> {
    let count = refresh_ollama_models(&state).await?;
    Ok(Json(json!({"success": true, "count": count})))
}

pub async fn setup_refresh_lmstudio_models(
    State(state): State<AppStateWrite>,
) -> Result<impl IntoResponse, ApiError> {
    let count = refresh_lmstudio_models(&state).await?;
    Ok(Json(json!({"success": true, "count": count})))
}

pub async fn setup_model_update_check(
    State(state): State<AppStateRead>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        check_model_update(&state, parse_model_update_check_target(&params)?).await?,
    ))
}

pub async fn setup_binary_update_info(
    State(state): State<AppStateRead>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    let info = fetch_binary_update_info(
        &state.core().paths,
        params
            .get("variant")
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty()),
    )
    .await?;

    Ok(Json(info))
}

pub async fn setup_binary_update(
    State(state): State<AppStateWrite>,
    Json(payload): Json<BinaryUpdateRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let requested_variant = payload.variant;
    let job_id = Uuid::new_v4().to_string();
    state.core().setup.set_job_id(Some(job_id.clone()))?;
    state
        .core()
        .setup
        .update_progress("pending", 0.0, "Starting binary update...")?;

    let state_clone = state.clone();
    tokio::spawn(async move {
        let result =
            install_latest_llama_binary(state_clone.shared(), requested_variant.as_deref()).await;
        match result {
            Ok(version) => {
                let _ = state_clone.core().setup.update_progress(
                    "completed",
                    1.0,
                    &format!("Updated llama.cpp binary to {}", version),
                );
            }
            Err(err) => {
                let _ = state_clone.core().setup.update_progress(
                    "failed",
                    0.0,
                    &format!("Update failed: {}", err),
                );
            }
        }
        let _ = state_clone.core().setup.set_job_id(None);
    });

    Ok(Json(json!({"success": true, "job_id": job_id})))
}

fn success_response() -> Json<Value> {
    Json(json!({"success": true}))
}
