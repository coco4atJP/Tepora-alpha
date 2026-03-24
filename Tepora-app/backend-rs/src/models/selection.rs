use crate::core::errors::ApiError;

use super::types::{ModelEntry, ModelRegistry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AssignmentTarget {
    Character,
    CharacterProfile(String),
    Agent(String),
    Professional,
    ProfessionalTask(String),
    Embedding,
}

impl AssignmentTarget {
    pub(crate) fn parse(value: &str) -> Result<Self, ApiError> {
        let normalized = value.trim();
        if normalized.is_empty() {
            return Err(ApiError::BadRequest(
                "assignment_key is required".to_string(),
            ));
        }

        if normalized == "character" {
            return Ok(Self::Character);
        }
        if normalized == "professional" {
            return Ok(Self::Professional);
        }
        if normalized == "embedding" {
            return Ok(Self::Embedding);
        }
        if let Some(subject) = normalized.strip_prefix("character:") {
            return Ok(Self::CharacterProfile(normalized_subject(subject, "character")?));
        }
        if let Some(subject) = normalized.strip_prefix("agent:") {
            return Ok(Self::Agent(normalized_subject(subject, "agent")?));
        }
        if let Some(subject) = normalized.strip_prefix("professional:") {
            return Ok(Self::ProfessionalTask(normalized_subject(
                subject,
                "professional",
            )?));
        }

        Err(ApiError::BadRequest(format!(
            "Unsupported assignment_key '{}'",
            normalized
        )))
    }

    pub(crate) fn key(&self) -> String {
        match self {
            Self::Character => "character".to_string(),
            Self::CharacterProfile(character_id) => format!("character:{character_id}"),
            Self::Agent(agent_id) => format!("agent:{agent_id}"),
            Self::Professional => "professional".to_string(),
            Self::ProfessionalTask(task_type) => format!("professional:{task_type}"),
            Self::Embedding => "embedding".to_string(),
        }
    }

    pub(crate) fn required_modality(&self) -> &'static str {
        match self {
            Self::Embedding => "embedding",
            Self::Character
            | Self::CharacterProfile(_)
            | Self::Agent(_)
            | Self::Professional
            | Self::ProfessionalTask(_) => "text",
        }
    }

    fn fallback_keys(&self) -> Vec<String> {
        match self {
            Self::Character => vec![self.key()],
            Self::CharacterProfile(_) => vec![self.key(), AssignmentTarget::Character.key()],
            Self::Agent(_) => vec![
                self.key(),
                AssignmentTarget::Professional.key(),
                AssignmentTarget::Character.key(),
            ],
            Self::ProfessionalTask(_) => vec![
                self.key(),
                AssignmentTarget::Professional.key(),
                AssignmentTarget::Character.key(),
            ],
            Self::Professional => vec![self.key(), AssignmentTarget::Character.key()],
            Self::Embedding => vec![self.key()],
        }
    }
}

fn normalized_subject(value: &str, target_type: &str) -> Result<String, ApiError> {
    let normalized = value.trim().trim_matches(':').trim();
    if normalized.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "{} assignment subject is required",
            target_type
        )));
    }
    Ok(normalized.to_string())
}

pub(crate) fn resolve_assignment_model_id_from_registry(
    registry: &ModelRegistry,
    assignment_key: &str,
) -> Result<Option<String>, ApiError> {
    let target = AssignmentTarget::parse(assignment_key)?;
    Ok(resolve_assignment_model_id(registry, &target))
}

pub(crate) fn resolve_assignment_model_from_registry(
    registry: &ModelRegistry,
    assignment_key: &str,
) -> Result<Option<ModelEntry>, ApiError> {
    let target = AssignmentTarget::parse(assignment_key)?;
    Ok(resolve_assignment_model(registry, &target))
}

pub(crate) fn resolve_character_model_id_from_registry(
    registry: &ModelRegistry,
    active_character_id: Option<&str>,
) -> Option<String> {
    active_character_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|character_id| {
            resolve_assignment_model_id(
                registry,
                &AssignmentTarget::CharacterProfile(character_id.to_string()),
            )
        })
        .or_else(|| resolve_assignment_model_id(registry, &AssignmentTarget::Character))
}

pub(crate) fn resolve_agent_model_id_from_registry(
    registry: &ModelRegistry,
    agent_id: Option<&str>,
) -> Option<String> {
    agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|agent_id| {
            resolve_assignment_model_id(registry, &AssignmentTarget::Agent(agent_id.to_string()))
        })
        .or_else(|| resolve_assignment_model_id(registry, &AssignmentTarget::Professional))
}

pub(crate) fn resolve_embedding_model_id_from_registry(registry: &ModelRegistry) -> Option<String> {
    resolve_assignment_model_id(registry, &AssignmentTarget::Embedding)
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

pub(crate) fn find_first_model_by_modality(
    registry: &ModelRegistry,
    modality: &str,
) -> Option<ModelEntry> {
    registry
        .models
        .iter()
        .find(|model| model.role == modality)
        .cloned()
}

pub(crate) fn validate_assignment_role(
    registry: &ModelRegistry,
    assignment_key: &str,
    model_id: &str,
) -> Result<(), ApiError> {
    let Some(model) = registry.models.iter().find(|m| m.id == model_id) else {
        return Ok(());
    };
    let target = AssignmentTarget::parse(assignment_key)?;
    let expected_modality = target.required_modality();

    if model.role != expected_modality {
        return Err(ApiError::BadRequest(format!(
            "Model '{}' has modality '{}', but assignment '{}' requires '{}'",
            model_id, model.role, assignment_key, expected_modality
        )));
    }

    Ok(())
}

fn resolve_assignment_model_id(
    registry: &ModelRegistry,
    target: &AssignmentTarget,
) -> Option<String> {
    for assignment_key in target.fallback_keys() {
        if let Some(model_id) = registry.role_assignments.get(&assignment_key) {
            return Some(model_id.clone());
        }
    }

    registry
        .models
        .iter()
        .find(|model| model.role == target.required_modality())
        .map(|model| model.id.clone())
}

fn resolve_assignment_model(
    registry: &ModelRegistry,
    target: &AssignmentTarget,
) -> Option<ModelEntry> {
    let model_id = resolve_assignment_model_id(registry, target)?;
    registry
        .models
        .iter()
        .find(|model| model.id == model_id)
        .cloned()
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
    fn assignment_target_parses_supported_keys() {
        assert_eq!(
            AssignmentTarget::parse("character:alice").expect("parse"),
            AssignmentTarget::CharacterProfile("alice".to_string())
        );
        assert_eq!(
            AssignmentTarget::parse("agent:coder").expect("parse"),
            AssignmentTarget::Agent("coder".to_string())
        );
        assert_eq!(
            AssignmentTarget::parse("professional:analysis").expect("parse"),
            AssignmentTarget::ProfessionalTask("analysis".to_string())
        );
        assert_eq!(
            AssignmentTarget::parse("embedding").expect("parse"),
            AssignmentTarget::Embedding
        );
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
    fn resolve_agent_model_prefers_professional_over_character_default() {
        let mut registry = ModelRegistry {
            models: vec![
                make_model_entry("text-a", "text"),
                make_model_entry("text-b", "text"),
            ],
            ..Default::default()
        };
        registry
            .role_assignments
            .insert("professional".to_string(), "text-b".to_string());
        registry
            .role_assignments
            .insert("character".to_string(), "text-a".to_string());

        let model_id = resolve_agent_model_id_from_registry(&registry, None).expect("model");
        assert_eq!(model_id, "text-b");
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
    fn validate_assignment_role_rejects_mismatched_modality() {
        let registry = ModelRegistry {
            models: vec![make_model_entry("embed-a", "embedding")],
            ..Default::default()
        };

        let result = validate_assignment_role(&registry, "character", "embed-a");
        assert!(result.is_err());
    }
}
