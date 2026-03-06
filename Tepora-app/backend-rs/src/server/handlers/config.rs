use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::core::errors::ApiError;
use crate::server::handlers::utils::absolutize_mcp_path;
use crate::state::{AppStateRead, AppStateWrite};

pub async fn get_config(State(state): State<AppStateRead>) -> Result<impl IntoResponse, ApiError> {
    let config = state.config.load_config()?;
    let mut redacted = state.config.redact_sensitive_values(&config);
    absolutize_mcp_path(&mut redacted, &state.paths);
    Ok(Json(redacted))
}

pub async fn update_config(
    State(state): State<AppStateWrite>,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    state.security.ensure_lockdown_disabled("config_update")?;
    state.config.update_config(payload, false)?;
    Ok(Json(json!({"status": "success"})))
}

pub async fn patch_config(
    State(state): State<AppStateWrite>,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    state.security.ensure_lockdown_disabled("config_patch")?;
    state.config.update_config(payload, true)?;
    Ok(Json(json!({"status": "success"})))
}

pub async fn rotate_secrets(
    State(state): State<AppStateWrite>,
) -> Result<impl IntoResponse, ApiError> {
    state.security.ensure_lockdown_disabled("secret_rotation")?;
    let rotated = state.config.rotate_secrets()?;
    state
        .security
        .record_audit("secrets_rotated", "success", json!({"rotated": rotated}))?;
    Ok(Json(json!({
        "status": "success",
        "rotated": rotated,
    })))
}
