use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use std::fs;
use std::sync::Arc;

use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::state::AppState;

pub async fn get_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let mut logs = Vec::new();
    let log_dir = &state.paths.log_dir;
    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("log") {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    logs.push((
                        name.to_string(),
                        entry.metadata().and_then(|m| m.modified()).ok(),
                    ));
                }
            }
        }
    }

    logs.sort_by(|a, b| b.1.cmp(&a.1));

    let log_names: Vec<String> = logs.into_iter().map(|(name, _)| name).collect();
    Ok(Json(json!(log_names)))
}

pub async fn get_log_content(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(filename): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let log_dir = &state.paths.log_dir;
    let path = log_dir.join(&filename);

    if !path.starts_with(log_dir) {
        return Err(ApiError::BadRequest("Invalid log path".to_string()));
    }

    if !path.exists() {
        return Err(ApiError::NotFound("Log file not found".to_string()));
    }

    let content = fs::read_to_string(path).map_err(ApiError::internal)?;
    Ok(content)
}
