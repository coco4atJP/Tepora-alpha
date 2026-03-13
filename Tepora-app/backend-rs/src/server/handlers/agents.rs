use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::core::errors::ApiError;
use crate::state::AppStateRead;

#[derive(Debug, Deserialize)]
pub struct ExecutionAgentQuery {
    #[serde(default)]
    pub enabled_only: bool,
}

pub async fn list_execution_agents(
    State(state): State<AppStateRead>,
    Query(query): Query<ExecutionAgentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let agents = if query.enabled_only {
        state.exclusive_agents.list_enabled()
    } else {
        state.exclusive_agents.list_all()
    };

    Ok(Json(json!({"agents": agents})))
}

pub async fn get_execution_agent(
    State(state): State<AppStateRead>,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let agent = state
        .exclusive_agents
        .get(&agent_id)
        .ok_or_else(|| ApiError::NotFound("Agent not found".to_string()))?;

    Ok(Json(json!(agent)))
}
