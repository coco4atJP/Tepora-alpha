use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

use crate::agent::skill_registry::AgentSkillSaveRequest;
use crate::core::errors::ApiError;
use crate::state::{AppStateRead, AppStateWrite};

pub async fn list_agent_skills(
    State(state): State<AppStateRead>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(json!({
        "roots": state.ai().skill_registry.list_roots(),
        "skills": state.ai().skill_registry.list_all(),
    })))
}

pub async fn get_agent_skill(
    State(state): State<AppStateRead>,
    Path(skill_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let skill = state
        .ai()
        .skill_registry
        .get(&skill_id)
        .ok_or_else(|| ApiError::NotFound("Agent Skill not found".to_string()))?;
    Ok(Json(json!(skill)))
}

pub async fn save_agent_skill(
    State(state): State<AppStateWrite>,
    Json(payload): Json<AgentSkillSaveRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .core()
        .security
        .ensure_lockdown_disabled("agent_skill_save")?;
    let skill = state.ai().skill_registry.save_package(payload)?;
    Ok(Json(json!({ "success": true, "skill": skill })))
}

pub async fn delete_agent_skill(
    State(state): State<AppStateWrite>,
    Path(skill_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .core()
        .security
        .ensure_lockdown_disabled("agent_skill_delete")?;
    let removed = state.ai().skill_registry.delete(&skill_id)?;
    if !removed {
        return Err(ApiError::NotFound("Agent Skill not found".to_string()));
    }
    Ok(Json(json!({ "success": true })))
}
