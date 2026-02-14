use std::sync::Arc;
use std::time::Duration;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use axum::http::HeaderMap;
use serde_json::json;

use crate::state::AppState;
use crate::core::errors::ApiError;
use crate::core::security::require_api_key;

pub async fn health(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "initialized": true,
        "core_version": "v2"
    }))
}

pub async fn shutdown(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(250)).await;
        std::process::exit(0);
    });

    Ok(Json(json!({"status": "shutting_down"})))
}

pub async fn get_status(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let total_messages = state
        .history
        .get_message_count("default")
        .await
        .unwrap_or(0);
    Ok(Json(json!({
        "initialized": true,
        "core_version": "v2",
        "em_llm_enabled": false,
        "degraded": true,
        "total_messages": total_messages,
        "memory_events": 0
    })))
}
