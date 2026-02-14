use std::sync::Arc;
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use axum::http::HeaderMap;
use serde::Deserialize;
use serde_json::{json, Value};
use chrono::Utc;

use crate::state::AppState;
use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use super::utils::{insert_config_section, merge_objects};

#[derive(Debug, Deserialize)]
pub struct CustomAgentQuery {
    #[serde(default)]
    pub enabled_only: bool,
}

pub async fn list_custom_agents(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CustomAgentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let list: Vec<Value> = agents
        .values()
        .filter(|agent| {
            if !query.enabled_only {
                return true;
            }
            agent
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true)
        })
        .cloned()
        .collect();

    Ok(Json(json!({"agents": list})))
}

pub async fn get_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let agent = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .and_then(|map| map.get(&agent_id))
        .cloned()
        .ok_or_else(|| ApiError::NotFound("Agent not found".to_string()))?;

    Ok(Json(agent))
}

pub async fn create_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("Agent ID is required".to_string()))?
        .to_string();
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("Agent name is required".to_string()))?
        .to_string();
    let system_prompt = payload
        .get("system_prompt")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("System prompt is required".to_string()))?
        .to_string();

    let mut config = state.config.load_config()?;
    let mut agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    if agents.contains_key(&id) {
        return Err(ApiError::BadRequest("Agent ID already exists".to_string()));
    }

    let now = Utc::now().to_rfc3339();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".to_string(), Value::String(id.clone()));
        obj.insert("name".to_string(), Value::String(name.to_string()));
        obj.insert(
            "system_prompt".to_string(),
            Value::String(system_prompt.to_string()),
        );
        obj.insert("created_at".to_string(), Value::String(now.clone()));
        obj.insert("updated_at".to_string(), Value::String(now.clone()));
    }

    agents.insert(id.clone(), payload.clone());
    insert_config_section(&mut config, "custom_agents", Value::Object(agents));
    state.config.update_config(config, false)?;

    Ok(Json(json!({"status": "success", "agent": payload})))
}

pub async fn update_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let mut config = state.config.load_config()?;
    let mut agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let existing = agents
        .get(&agent_id)
        .cloned()
        .ok_or_else(|| ApiError::NotFound("Agent not found".to_string()))?;

    let mut merged = merge_objects(existing, payload);
    if let Some(obj) = merged.as_object_mut() {
        obj.insert("id".to_string(), Value::String(agent_id.clone()));
        obj.insert(
            "updated_at".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
    }

    agents.insert(agent_id.clone(), merged.clone());
    insert_config_section(&mut config, "custom_agents", Value::Object(agents));
    state.config.update_config(config, false)?;

    Ok(Json(json!({"status": "success", "agent": merged})))
}

pub async fn delete_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let mut config = state.config.load_config()?;
    let mut agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    if agents.remove(&agent_id).is_none() {
        return Err(ApiError::NotFound("Agent not found".to_string()));
    }

    insert_config_section(&mut config, "custom_agents", Value::Object(agents));
    state.config.update_config(config, false)?;

    Ok(Json(json!({"status": "success"})))
}
