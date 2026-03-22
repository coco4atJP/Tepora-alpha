use serde_json::{json, Map, Value};

use super::setup_models::{ensure_role_assignment_exists, ensure_role_model_exists};
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
        .set_role_model("character", model_id)
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

    state
        .ai()
        .models
        .update_active_model_config("text", model_id)
        .map_err(|e| {
            tracing::warn!(model_id = %model_id, error = %e, "Failed to update active model config");
            ApiError::BadRequest(format!("Failed to activate model '{}': {}", model_id, e))
        })?;
    Ok(())
}

pub fn set_professional_role(
    state: &AppStateWrite,
    task_type: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let role_key = professional_role_key(task_type);
    ensure_role_model_exists(state, &role_key, model_id)
}

pub fn set_character_specific_role(
    state: &AppStateWrite,
    character_id: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let character_id = normalized_assignment_subject(character_id, "character_id")?;
    let role_key = format!("character:{character_id}");
    ensure_role_model_exists(state, &role_key, model_id)
}

pub fn delete_character_specific_role(
    state: &AppStateWrite,
    character_id: &str,
) -> Result<(), ApiError> {
    let character_id = normalized_assignment_subject(character_id, "character_id")?;
    let role_key = format!("character:{character_id}");
    ensure_role_assignment_exists(state, &role_key)
}

pub fn set_agent_role(
    state: &AppStateWrite,
    agent_id: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let agent_id = normalized_assignment_subject(agent_id, "agent_id")?;
    let role_key = format!("agent:{agent_id}");
    ensure_role_model_exists(state, &role_key, model_id)
}

pub fn delete_agent_role(state: &AppStateWrite, agent_id: &str) -> Result<(), ApiError> {
    let agent_id = normalized_assignment_subject(agent_id, "agent_id")?;
    let role_key = format!("agent:{agent_id}");
    ensure_role_assignment_exists(state, &role_key)
}

pub fn delete_professional_role(state: &AppStateWrite, task_type: &str) -> Result<(), ApiError> {
    ensure_role_assignment_exists(state, &professional_role_key(task_type))
}

pub fn set_active_model(
    state: &AppStateWrite,
    model_id: &str,
    role: Option<&str>,
) -> Result<(), ApiError> {
    let requested_role = role.unwrap_or("text").to_ascii_lowercase();
    let (role_key, config_role) = if requested_role == "embedding" {
        ("embedding", "embedding")
    } else {
        ("character", "text")
    };

    let assigned = state
        .ai()
        .models
        .set_role_model(role_key, model_id)
        .map_err(|e| {
            tracing::warn!(
                model_id = %model_id,
                role = %role_key,
                error = %e,
                "Failed to set active role assignment"
            );
            ApiError::BadRequest(format!(
                "Failed to set '{}' role for model '{}': {}",
                role_key, model_id, e
            ))
        })?;
    if !assigned {
        return Err(ApiError::NotFound(format!(
            "Model '{}' not found in registry",
            model_id
        )));
    }

    state
        .ai()
        .models
        .update_active_model_config(config_role, model_id)
        .map_err(|e| {
            tracing::warn!(
                model_id = %model_id,
                role = %config_role,
                error = %e,
                "Failed to set active model"
            );
            match e {
                ApiError::NotFound(_) => {
                    ApiError::NotFound(format!("Model '{}' not found in registry", model_id))
                }
                ApiError::BadRequest(msg) => ApiError::BadRequest(format!(
                    "Failed to activate model '{}': {}",
                    model_id, msg
                )),
                ApiError::Conflict(msg) => {
                    ApiError::Conflict(format!("Failed to activate model '{}': {}", model_id, msg))
                }
                ApiError::Internal(msg) => {
                    ApiError::Internal(format!("Failed to activate model '{}': {}", model_id, msg))
                }
                other => other,
            }
        })?;
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
