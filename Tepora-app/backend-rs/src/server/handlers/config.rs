use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::server::handlers::utils::absolutize_mcp_path;
use crate::state::AppState;

pub async fn get_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let mut redacted = state.config.redact_sensitive_values(&config);
    absolutize_mcp_path(&mut redacted, &state.paths);
    Ok(Json(redacted))
}

pub async fn update_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.config.update_config(payload, false)?;
    Ok(Json(json!({"status": "success"})))
}

pub async fn patch_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.config.update_config(payload, true)?;
    Ok(Json(json!({"status": "success"})))
}
