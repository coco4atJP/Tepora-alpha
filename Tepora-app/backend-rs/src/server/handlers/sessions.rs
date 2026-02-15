use std::sync::Arc;
use std::collections::HashMap;
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use axum::http::HeaderMap;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::state::AppState;
use crate::core::errors::ApiError;
use crate::core::security::require_api_key;

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSessionRequest {
    pub title: String,
}

pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let sessions = state.history.list_sessions().await?;
    let result: Vec<Value> = sessions
        .into_iter()
        .map(|session| {
            json!({
                "id": session.id,
                "title": session.title,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "message_count": session.message_count,
                "preview": session.preview
            })
        })
        .collect();
    Ok(Json(json!({"sessions": result})))
}

pub async fn create_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let session_id = state.history.create_session(payload.title).await?;
    let session = state.history.get_session(&session_id).await?;
    Ok(Json(json!({"session": session})))
}

pub async fn get_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let session = state
        .history
        .get_session(&session_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Session not found".to_string()))?;

    let messages = state.history.get_history(&session_id, 100).await?;
    let message_payload: Vec<Value> = messages
        .into_iter()
        .map(|msg| {
            json!({
                "type": msg.message_type,
                "content": msg.content
            })
        })
        .collect();

    Ok(Json(
        json!({"session": session, "messages": message_payload}),
    ))
}

pub async fn get_session_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(100);

    let messages = state.history.get_history(&session_id, limit).await?;

    let formatted: Vec<Value> = messages
        .into_iter()
        .map(|msg| {
            let role = match msg.message_type.as_str() {
                "ai" => "assistant",
                "system" => "system",
                _ => "user",
            };
            let timestamp = msg
                .additional_kwargs
                .as_ref()
                .and_then(|k| k.get("timestamp"))
                .and_then(|v| v.as_str())
                .unwrap_or(&msg.created_at);
            let mode = msg
                .additional_kwargs
                .as_ref()
                .and_then(|k| k.get("mode"))
                .and_then(|v| v.as_str())
                .unwrap_or("chat");

            json!({
                "id": Uuid::new_v4().to_string(),
                "role": role,
                "content": msg.content,
                "timestamp": timestamp,
                "mode": mode,
                "isComplete": true
            })
        })
        .collect();

    Ok(Json(json!({"messages": formatted})))
}

pub async fn update_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<UpdateSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let _ = state
        .history
        .update_session_title(&session_id, &payload.title)
        .await?;
    // if !success check removed as update returns ()
    Ok(Json(json!({"success": true})))
}

pub async fn delete_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let _ = state.history.delete_session(&session_id).await?;
    // if !success check removed
    Ok(Json(json!({"success": true})))
}
