use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::exclusive_manager::{AgentToolPolicy, ExecutionAgent};
use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::state::{AppStateRead, AppStateWrite};

#[derive(Debug, Deserialize)]
pub struct CustomAgentQuery {
    #[serde(default)]
    pub enabled_only: bool,
}

pub async fn list_custom_agents(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
    Query(query): Query<CustomAgentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let agents = if query.enabled_only {
        state.exclusive_agents.list_enabled()
    } else {
        state.exclusive_agents.list_all()
    };

    Ok(Json(json!({"agents": agents})))
}

pub async fn get_custom_agent(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let agent = state
        .exclusive_agents
        .get(&agent_id)
        .ok_or_else(|| ApiError::NotFound("Agent not found".to_string()))?;

    Ok(Json(json!(agent)))
}

pub async fn create_custom_agent(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("Agent ID is required".to_string()))?
        .to_string();

    if state.exclusive_agents.get(&id).is_some() {
        return Err(ApiError::BadRequest("Agent ID already exists".to_string()));
    }

    let agent = parse_agent_payload(id, &payload, None)?;
    state.exclusive_agents.upsert(agent.clone())?;

    Ok(Json(json!({"status": "success", "agent": agent})))
}

pub async fn update_custom_agent(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let existing = state
        .exclusive_agents
        .get(&agent_id)
        .ok_or_else(|| ApiError::NotFound("Agent not found".to_string()))?;

    let updated = parse_agent_payload(agent_id.clone(), &payload, Some(existing))?;
    state.exclusive_agents.upsert(updated.clone())?;

    Ok(Json(json!({"status": "success", "agent": updated})))
}

pub async fn delete_custom_agent(
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let removed = state.exclusive_agents.delete(&agent_id)?;
    if !removed {
        return Err(ApiError::NotFound("Agent not found".to_string()));
    }

    Ok(Json(json!({"status": "success"})))
}

fn parse_agent_payload(
    id: String,
    payload: &Value,
    existing: Option<ExecutionAgent>,
) -> Result<ExecutionAgent, ApiError> {
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| existing.as_ref().map(|a| a.name.clone()))
        .ok_or_else(|| ApiError::BadRequest("Agent name is required".to_string()))?;

    let system_prompt = payload
        .get("system_prompt")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .or_else(|| existing.as_ref().map(|a| a.system_prompt.clone()))
        .ok_or_else(|| ApiError::BadRequest("System prompt is required".to_string()))?;

    let description = payload
        .get("description")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .or_else(|| existing.as_ref().map(|a| a.description.clone()))
        .unwrap_or_default();

    let enabled = payload
        .get("enabled")
        .and_then(|v| v.as_bool())
        .or_else(|| existing.as_ref().map(|a| a.enabled))
        .unwrap_or(true);

    let model_config_name = payload
        .get("model_config_name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| existing.as_ref().and_then(|a| a.model_config_name.clone()));

    let priority = payload
        .get("priority")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .or_else(|| existing.as_ref().map(|a| a.priority))
        .unwrap_or(0);

    let tags = payload
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .or_else(|| existing.as_ref().map(|a| a.tags.clone()))
        .unwrap_or_default();

    let icon = payload
        .get("icon")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
        .or_else(|| existing.as_ref().and_then(|a| a.icon.clone()));

    let tool_policy = match payload.get("tool_policy") {
        Some(value) => serde_json::from_value::<AgentToolPolicy>(value.clone())
            .map_err(|e| ApiError::BadRequest(format!("Invalid tool_policy: {e}")))?,
        None => existing.map(|a| a.tool_policy).unwrap_or_default(),
    };

    Ok(ExecutionAgent {
        id,
        name,
        description,
        enabled,
        system_prompt,
        model_config_name,
        tool_policy,
        priority,
        tags,
        icon,
    })
}
