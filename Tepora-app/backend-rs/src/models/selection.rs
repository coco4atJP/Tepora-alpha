use crate::core::errors::ApiError;

use super::types::{ModelEntry, ModelRegistry};

fn normalized_subject_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

pub(crate) fn resolve_character_model_id_from_registry(
    registry: &ModelRegistry,
    active_character_id: Option<&str>,
) -> Option<String> {
    if let Some(character_id) = normalized_subject_id(active_character_id) {
        let key = format!("character:{}", character_id);
        if let Some(model_id) = registry.role_assignments.get(&key) {
            return Some(model_id.clone());
        }
    }

    registry
        .role_assignments
        .get("character")
        .cloned()
        .or_else(|| registry.role_assignments.get("text").cloned())
        .or_else(|| {
            registry
                .models
                .iter()
                .find(|model| model.role == "text")
                .map(|model| model.id.clone())
        })
}

pub(crate) fn resolve_agent_model_id_from_registry(
    registry: &ModelRegistry,
    agent_id: Option<&str>,
) -> Option<String> {
    if let Some(agent) = normalized_subject_id(agent_id) {
        let key = format!("agent:{}", agent);
        if let Some(model_id) = registry.role_assignments.get(&key) {
            return Some(model_id.clone());
        }
    }

    if let Some(model_id) = registry.role_assignments.get("professional") {
        return Some(model_id.clone());
    }

    resolve_character_model_id_from_registry(registry, None)
}

pub(crate) fn resolve_embedding_model_id_from_registry(registry: &ModelRegistry) -> Option<String> {
    registry
        .role_assignments
        .get("embedding")
        .cloned()
        .or_else(|| {
            registry
                .models
                .iter()
                .find(|model| model.role == "embedding")
                .map(|model| model.id.clone())
        })
}

pub(crate) fn resolve_character_model(
    registry: &ModelRegistry,
    active_character_id: Option<&str>,
) -> Option<ModelEntry> {
    let model_id = resolve_character_model_id_from_registry(registry, active_character_id)?;
    registry
        .models
        .iter()
        .find(|model| model.id == model_id)
        .cloned()
}

pub(crate) fn resolve_embedding_model(registry: &ModelRegistry) -> Option<ModelEntry> {
    let model_id = resolve_embedding_model_id_from_registry(registry)?;
    registry
        .models
        .iter()
        .find(|model| model.id == model_id)
        .cloned()
}

pub(crate) fn find_first_model_by_role(registry: &ModelRegistry, role: &str) -> Option<ModelEntry> {
    registry
        .models
        .iter()
        .find(|model| model.role == role)
        .cloned()
}

pub(crate) fn validate_assignment_role(
    registry: &ModelRegistry,
    role: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let Some(model) = registry.models.iter().find(|m| m.id == model_id) else {
        return Ok(());
    };

    if let Some(expected_role) = expected_model_role_for_assignment(role) {
        if model.role != expected_role {
            return Err(ApiError::BadRequest(format!(
                "Model '{}' has role '{}', but assignment '{}' requires '{}'",
                model_id, model.role, role, expected_role
            )));
        }
    }

    Ok(())
}

fn expected_model_role_for_assignment(role: &str) -> Option<&'static str> {
    let normalized = role.trim();
    if normalized.is_empty() {
        return None;
    }

    if normalized == "embedding" || normalized.starts_with("embedding:") {
        return Some("embedding");
    }

    if normalized == "text"
        || normalized == "character"
        || normalized.starts_with("character:")
        || normalized == "professional"
        || normalized.starts_with("professional:")
        || normalized.starts_with("agent:")
    {
        return Some("text");
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ModelCapabilities, ModelRegistry};

    fn make_model_entry(id: &str, role: &str) -> ModelEntry {
        ModelEntry {
            id: id.to_string(),
            display_name: id.to_string(),
            role: role.to_string(),
            file_size: 1,
            filename: id.to_string(),
            source: "local".to_string(),
            file_path: format!("/tmp/{}.gguf", id),
            loader: "llama_cpp".to_string(),
            loader_model_name: Some(id.to_string()),
            repo_id: None,
            revision: None,
            sha256: None,
            added_at: "2026-01-01T00:00:00Z".to_string(),
            parameter_size: None,
            quantization: None,
            context_length: None,
            architecture: None,
            chat_template: None,
            stop_tokens: None,
            default_temperature: None,
            capabilities: Some(ModelCapabilities::default()),
            publisher: None,
            description: None,
            format: Some("gguf".to_string()),
            tokenizer_path: None,
            tokenizer_format: None,
        }
    }

    #[test]
    fn resolve_character_model_prefers_character_specific_assignment() {
        let mut registry = ModelRegistry {
            models: vec![
                make_model_entry("text-a", "text"),
                make_model_entry("text-b", "text"),
            ],
            ..Default::default()
        };
        registry
            .role_assignments
            .insert("character:alice".to_string(), "text-b".to_string());
        registry
            .role_assignments
            .insert("character".to_string(), "text-a".to_string());

        let model = resolve_character_model(&registry, Some("alice")).expect("model");
        assert_eq!(model.id, "text-b");
    }

    #[test]
    fn resolve_embedding_model_falls_back_to_first_embedding() {
        let registry = ModelRegistry {
            models: vec![
                make_model_entry("text-a", "text"),
                make_model_entry("embed-a", "embedding"),
            ],
            ..Default::default()
        };

        let model = resolve_embedding_model(&registry).expect("embedding");
        assert_eq!(model.id, "embed-a");
    }

    #[test]
    fn validate_assignment_role_rejects_mismatched_role() {
        let registry = ModelRegistry {
            models: vec![make_model_entry("embed-a", "embedding")],
            ..Default::default()
        };

        let result = validate_assignment_role(&registry, "character", "embed-a");
        assert!(result.is_err());
    }
}
