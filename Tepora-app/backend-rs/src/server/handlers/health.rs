use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::state::AppState;

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

pub async fn get_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let total_messages = state
        .history
        .get_total_message_count()
        .await
        .unwrap_or(0);
    let memory_stats = state.em_memory_service.stats().await?;
    Ok(Json(json!({
        "initialized": true,
        "core_version": "v2",
        "em_llm_enabled": memory_stats.enabled,
        "degraded": false,
        "total_messages": total_messages,
        "memory_events": memory_stats.total_events,
        "retrieval": {
            "limit": memory_stats.retrieval_limit,
            "min_score": memory_stats.min_score
        }
    })))
}
