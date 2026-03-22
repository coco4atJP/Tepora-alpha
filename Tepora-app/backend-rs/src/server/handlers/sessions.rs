use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

use crate::core::errors::ApiError;
use crate::state::{AppStateRead, AppStateWrite};

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSessionRequest {
    pub title: String,
}

pub async fn list_sessions(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    let sessions = state.runtime().history.list_sessions().await?;
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
    State(state): State<AppStateWrite>,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session_id = state
        .runtime()
        .history
        .create_session(payload.title)
        .await?;
    let session = state.runtime().history.get_session(&session_id).await?;
    Ok(Json(json!({"session": session})))
}

pub async fn get_session(
    State(state): State<AppStateRead>,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let session = state
        .runtime()
        .history
        .get_session(&session_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Session not found".to_string()))?;

    let messages = state
        .runtime()
        .history
        .get_history(&session_id, 100)
        .await?;
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
    State(state): State<AppStateRead>,
    Path(session_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(100);

    let messages = state
        .runtime()
        .history
        .get_history(&session_id, limit)
        .await?;

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
    State(state): State<AppStateWrite>,
    Path(session_id): Path<String>,
    Json(payload): Json<UpdateSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .runtime()
        .history
        .update_session_title(&session_id, &payload.title)
        .await?;
    // if !success check removed as update returns ()
    Ok(Json(json!({"success": true})))
}

pub async fn delete_session(
    State(state): State<AppStateWrite>,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.runtime().history.delete_session(&session_id).await?;
    // if !success check removed
    Ok(Json(json!({"success": true})))
}
