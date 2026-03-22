use crate::core::errors::ApiError;
use serde_json::Value;

use super::validation_primitives::expect_optional_object;
use super::validation_sections::{
    validate_agent_section, validate_agent_skills_section, validate_app_section,
    validate_backup_section, validate_characters_section, validate_context_window_section,
    validate_credentials_section, validate_features_section, validate_llm_defaults_section,
    validate_llm_manager_section, validate_model_download_section, validate_models_section,
    validate_permissions_section, validate_privacy_section, validate_quarantine_section,
    validate_rag_section, validate_search_section, validate_server_section, validate_tools_section,
};

pub fn validate_config(config: &Value) -> Result<(), ApiError> {
    let root = config.as_object().ok_or_else(|| {
        ApiError::BadRequest("Invalid config at 'root': expected object".to_string())
    })?;

    if let Some(app) = expect_optional_object(root, "app")? {
        validate_app_section(app)?;
    }

    if let Some(llm_manager) = expect_optional_object(root, "llm_manager")? {
        validate_llm_manager_section(llm_manager)?;
    }

    if let Some(server) = expect_optional_object(root, "server")? {
        validate_server_section(server)?;
    }

    if let Some(privacy) = expect_optional_object(root, "privacy")? {
        validate_privacy_section(privacy)?;
    }

    if let Some(search) = expect_optional_object(root, "search")? {
        validate_search_section(search)?;
    }

    if let Some(rag) = expect_optional_object(root, "rag")? {
        validate_rag_section(rag)?;
    }

    if let Some(agent) = expect_optional_object(root, "agent")? {
        validate_agent_section(agent)?;
    }

    if let Some(tools) = expect_optional_object(root, "tools")? {
        validate_tools_section(tools)?;
    }

    if let Some(download) = expect_optional_object(root, "model_download")? {
        validate_model_download_section(download)?;
    }

    if let Some(permissions) = expect_optional_object(root, "permissions")? {
        validate_permissions_section(permissions)?;
    }

    if let Some(credentials) = expect_optional_object(root, "credentials")? {
        validate_credentials_section(credentials)?;
    }

    if let Some(backup) = expect_optional_object(root, "backup")? {
        validate_backup_section(backup)?;
    }

    if let Some(quarantine) = expect_optional_object(root, "quarantine")? {
        validate_quarantine_section(quarantine)?;
    }

    let models_key = if root.contains_key("models") {
        "models"
    } else {
        "models_gguf"
    };
    validate_models_section(root, models_key)?;

    if let Some(llm_defaults) = expect_optional_object(root, "llm_defaults")? {
        validate_llm_defaults_section(llm_defaults)?;
    }

    if let Some(characters) = expect_optional_object(root, "characters")? {
        validate_characters_section(characters)?;
    }

    if let Some(agent_skills) = expect_optional_object(root, "agent_skills")? {
        validate_agent_skills_section(agent_skills)?;
    }

    if let Some(features) = expect_optional_object(root, "features")? {
        validate_features_section(features)?;
    }

    if let Some(context_window) = expect_optional_object(root, "context_window")? {
        validate_context_window_section(context_window)?;
    }

    Ok(())
}
