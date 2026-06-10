use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::core::errors::ApiError;
use crate::state::{AppStateRead, AppStateWrite};
use crate::workspace::CreateProjectRequest;

#[derive(Debug, Deserialize)]
pub struct WorkspaceDocumentPayload {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceRenamePayload {
    pub new_path: String,
}

pub async fn list_projects(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    let current_project_id = state.workspace().manager.current_project_id().await;
    let projects = state.workspace().manager.list_projects()?;
    Ok(Json(json!({
        "projects": projects,
        "current_project_id": current_project_id,
        "revision": state.workspace().manager.revision(),
    })))
}

pub async fn create_project(
    State(state): State<AppStateWrite>,
    Json(payload): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let project = state.workspace().manager.create_project(payload)?;
    state
        .workspace()
        .manager
        .set_current_project(&project.id)
        .await?;
    Ok(Json(json!({ "project": project })))
}

pub async fn set_current_project(
    State(state): State<AppStateWrite>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .workspace()
        .manager
        .set_current_project(&project_id)
        .await?;
    Ok(Json(json!({ "success": true, "project_id": project_id })))
}

pub async fn get_current_tree(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = state.workspace().manager.current_project_id().await;
    let tree = state.workspace().manager.tree(&project_id)?;
    Ok(Json(json!({
        "project_id": project_id,
        "revision": state.workspace().manager.revision(),
        "tree": tree,
    })))
}

pub async fn read_document(
    State(state): State<AppStateRead>,
    Path(path): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = state.workspace().manager.current_project_id().await;
    let document = state
        .workspace()
        .manager
        .read_document(&project_id, &path)?;
    Ok(Json(document))
}

pub async fn write_document(
    State(state): State<AppStateWrite>,
    Path(path): Path<String>,
    Json(payload): Json<WorkspaceDocumentPayload>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = state.workspace().manager.current_project_id().await;
    let document =
        state
            .workspace()
            .manager
            .write_document(&project_id, &path, &payload.content)?;
    Ok(Json(document))
}

pub async fn create_directory(
    State(state): State<AppStateWrite>,
    Path(path): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = state.workspace().manager.current_project_id().await;
    state
        .workspace()
        .manager
        .create_directory(&project_id, &path)?;
    Ok(Json(json!({ "success": true, "path": path })))
}

pub async fn rename_path(
    State(state): State<AppStateWrite>,
    Path(old_path): Path<String>,
    Json(payload): Json<WorkspaceRenamePayload>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = state.workspace().manager.current_project_id().await;
    state
        .workspace()
        .manager
        .rename_path(&project_id, &old_path, &payload.new_path)?;
    Ok(Json(
        json!({ "success": true, "old_path": old_path, "new_path": payload.new_path }),
    ))
}

pub async fn delete_path(
    State(state): State<AppStateWrite>,
    Path(path): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let project_id = state.workspace().manager.current_project_id().await;
    state.workspace().manager.delete_path(&project_id, &path)?;
    Ok(Json(json!({ "success": true, "path": path })))
}
