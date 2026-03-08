use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::core::errors::ApiError;
use crate::core::security_controls::{
    BackupExportRequest, BackupImportRequest, PermissionScopeKind,
};
use crate::state::{AppStateRead, AppStateWrite};

#[derive(Debug, Deserialize)]
pub struct LockdownRequest {
    pub enabled: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CredentialRotateRequest {
    pub provider: String,
    pub secret: String,
    #[serde(default)]
    pub expires_at: Option<String>,
}

pub async fn set_lockdown(
    State(state): State<AppStateWrite>,
    Json(payload): Json<LockdownRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let config = state
        .security
        .update_lockdown(payload.enabled, payload.reason.as_deref())?;
    Ok(Json(json!({ "success": true, "config": config })))
}

pub async fn list_permissions(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    let permissions = state.security.list_permissions()?;
    Ok(Json(json!({ "permissions": permissions })))
}

pub async fn revoke_permission(
    State(state): State<AppStateWrite>,
    Path((kind, name)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let scope_kind = match kind.as_str() {
        "native_tool" | "native_tools" => PermissionScopeKind::NativeTool,
        "mcp_server" | "mcp_servers" => PermissionScopeKind::McpServer,
        _ => {
            return Err(ApiError::BadRequest(format!(
                "Unknown permission kind '{}'",
                kind
            )))
        }
    };
    let removed = state.security.revoke_permission(scope_kind, &name)?;
    if !removed {
        return Err(ApiError::NotFound("Permission not found".to_string()));
    }
    Ok(Json(json!({ "success": true })))
}

pub async fn verify_audit(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.security.verify_audit_chain()?))
}

pub async fn credential_statuses(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        json!({ "credentials": state.security.credential_statuses()? }),
    ))
}

pub async fn rotate_credential(
    State(state): State<AppStateWrite>,
    Json(payload): Json<CredentialRotateRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.security.rotate_credential(
        &payload.provider,
        &payload.secret,
        payload.expires_at.as_deref(),
    )?;
    Ok(Json(json!({ "success": true })))
}

pub async fn export_backup(
    State(state): State<AppStateWrite>,
    Json(payload): Json<BackupExportRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.security.ensure_lockdown_disabled("backup_export")?;
    let archive = state
        .security
        .export_backup(&payload, &state.history)
        .await?;
    Ok(Json(json!({ "success": true, "archive": archive })))
}

pub async fn import_backup(
    State(state): State<AppStateWrite>,
    Json(payload): Json<BackupImportRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if payload.stage.eq_ignore_ascii_case("apply") {
        state.security.ensure_lockdown_disabled("backup_import")?;
    }
    let result = state
        .security
        .import_backup(&payload, &state.history)
        .await?;
    Ok(Json(json!({ "success": true, "result": result })))
}
