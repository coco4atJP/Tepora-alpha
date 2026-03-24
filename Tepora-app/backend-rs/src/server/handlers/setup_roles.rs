use serde_json::{json, Map, Value};

use super::setup_models::{ensure_assignment_exists, ensure_assignment_model_exists};
use crate::core::errors::ApiError;
use crate::state::{AppStateRead, AppStateWrite};

pub fn model_roles_payload(state: &AppStateRead) -> Result<Value, ApiError> {
    let registry = state.ai().models.get_registry()?;
    let character_model_id = registry.role_assignments.get("character").cloned();
    let mut character_map = Map::new();
    let mut agent_map = Map::new();
    let mut professional_map = Map::new();
    for (key, value) in registry.role_assignments.iter() {
        if key == "professional" {
            professional_map.insert("default".to_string(), Value::String(value.clone()));
        } else if let Some(character) = key.strip_prefix("character:") {
            character_map.insert(character.to_string(), Value::String(value.clone()));
        } else if let Some(agent) = key.strip_prefix("agent:") {
            agent_map.insert(agent.to_string(), Value::String(value.clone()));
        } else if let Some(task) = key.strip_prefix("professional:") {
            professional_map.insert(task.to_string(), Value::String(value.clone()));
        }
    }

    Ok(json!({
        "character_model_id": character_model_id,
        "character_model_map": character_map,
        "agent_model_map": agent_map,
        "professional_model_map": professional_map
    }))
}

pub fn set_character_role(state: &AppStateWrite, model_id: &str) -> Result<(), ApiError> {
    let ok = state
        .ai()
        .models
        .set_assignment_model("character", model_id)
        .map_err(|e| {
            tracing::warn!(model_id = %model_id, error = %e, "Failed to set character role");
            ApiError::BadRequest(format!(
                "Failed to set character role for model '{}': {}",
                model_id, e
            ))
        })?;
    if !ok {
        return Err(ApiError::NotFound(format!(
            "Model '{}' not found in registry",
            model_id
        )));
    }

    Ok(())
}

pub fn set_professional_role(
    state: &AppStateWrite,
    task_type: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let assignment_key = professional_role_key(task_type);
    ensure_assignment_model_exists(state, &assignment_key, model_id)
}

pub fn set_character_specific_role(
    state: &AppStateWrite,
    character_id: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let character_id = normalized_assignment_subject(character_id, "character_id")?;
    let assignment_key = format!("character:{character_id}");
    ensure_assignment_model_exists(state, &assignment_key, model_id)
}

pub fn delete_character_specific_role(
    state: &AppStateWrite,
    character_id: &str,
) -> Result<(), ApiError> {
    let character_id = normalized_assignment_subject(character_id, "character_id")?;
    let assignment_key = format!("character:{character_id}");
    ensure_assignment_exists(state, &assignment_key)
}

pub fn set_agent_role(
    state: &AppStateWrite,
    agent_id: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let agent_id = normalized_assignment_subject(agent_id, "agent_id")?;
    let assignment_key = format!("agent:{agent_id}");
    ensure_assignment_model_exists(state, &assignment_key, model_id)
}

pub fn delete_agent_role(state: &AppStateWrite, agent_id: &str) -> Result<(), ApiError> {
    let agent_id = normalized_assignment_subject(agent_id, "agent_id")?;
    let assignment_key = format!("agent:{agent_id}");
    ensure_assignment_exists(state, &assignment_key)
}

pub fn delete_professional_role(state: &AppStateWrite, task_type: &str) -> Result<(), ApiError> {
    ensure_assignment_exists(state, &professional_role_key(task_type))
}

pub fn set_active_model(
    state: &AppStateWrite,
    model_id: &str,
    assignment_key: &str,
) -> Result<(), ApiError> {
    let assigned = state
        .ai()
        .models
        .set_assignment_model(assignment_key, model_id)
        .map_err(|e| {
            tracing::warn!(
                model_id = %model_id,
                assignment_key = %assignment_key,
                error = %e,
                "Failed to set active assignment"
            );
            ApiError::BadRequest(format!(
                "Failed to set assignment '{}' for model '{}': {}",
                assignment_key, model_id, e
            ))
        })?;
    if !assigned {
        return Err(ApiError::NotFound(format!(
            "Model '{}' not found in registry",
            model_id
        )));
    }

    Ok(())
}

fn professional_role_key(task_type: &str) -> String {
    if task_type == "default" {
        "professional".to_string()
    } else {
        format!("professional:{task_type}")
    }
}

fn normalized_assignment_subject(value: &str, field_name: &str) -> Result<String, ApiError> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(ApiError::BadRequest(format!("{field_name} is required")));
    }
    Ok(normalized.to_string())
}
