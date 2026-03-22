use crate::core::errors::ApiError;
use serde_json::{Map, Value};

use super::validation_primitives::{
    config_type_error, expect_optional_object, validate_bool_field, validate_i64_field,
    validate_number_field, validate_optional_string_field, validate_required_string_field,
    validate_string_array_field, validate_string_enum_field, validate_u64_field,
};

pub(super) fn validate_app_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_u64_field(
        section,
        "app.max_input_length",
        "max_input_length",
        1,
        10_000_000,
    )?;
    validate_u64_field(
        section,
        "app.graph_recursion_limit",
        "graph_recursion_limit",
        1,
        10_000,
    )?;
    validate_u64_field(
        section,
        "app.tool_execution_timeout",
        "tool_execution_timeout",
        1,
        86_400,
    )?;
    validate_u64_field(
        section,
        "app.tool_approval_timeout",
        "tool_approval_timeout",
        1,
        86_400,
    )?;
    validate_u64_field(
        section,
        "app.web_fetch_max_chars",
        "web_fetch_max_chars",
        1,
        5_000_000,
    )?;
    validate_u64_field(
        section,
        "app.web_fetch_timeout_secs",
        "web_fetch_timeout_secs",
        1,
        86_400,
    )?;
    validate_u64_field(
        section,
        "app.web_fetch_max_bytes",
        "web_fetch_max_bytes",
        1,
        100_000_000,
    )?;
    validate_u64_field(
        section,
        "app.graph_execution_timeout",
        "graph_execution_timeout",
        1_000,
        3_600_000,
    )?;
    validate_u64_field(section, "app.history_limit", "history_limit", 1, 1_000)?;
    validate_u64_field(
        section,
        "app.entity_extraction_limit",
        "entity_extraction_limit",
        1,
        100,
    )?;
    Ok(())
}

pub(super) fn validate_llm_manager_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_optional_string_field(section, "llm_manager.loader", "loader")?;
    validate_u64_field(
        section,
        "llm_manager.process_terminate_timeout",
        "process_terminate_timeout",
        1,
        3_600_000,
    )?;
    validate_u64_field(
        section,
        "llm_manager.external_request_timeout_ms",
        "external_request_timeout_ms",
        1,
        3_600_000,
    )?;
    validate_u64_field(
        section,
        "llm_manager.stream_idle_timeout_ms",
        "stream_idle_timeout_ms",
        1,
        3_600_000,
    )?;
    validate_u64_field(
        section,
        "llm_manager.health_check_timeout",
        "health_check_timeout",
        1,
        3_600_000,
    )?;
    validate_u64_field(
        section,
        "llm_manager.health_check_interval",
        "health_check_interval",
        1,
        3_600_000,
    )?;
    validate_u64_field(
        section,
        "llm_manager.health_check_interval_ms",
        "health_check_interval_ms",
        1,
        3_600_000,
    )?;
    validate_u64_field(
        section,
        "llm_manager.stream_channel_buffer",
        "stream_channel_buffer",
        1,
        65_536,
    )?;
    validate_u64_field(
        section,
        "llm_manager.stream_internal_buffer",
        "stream_internal_buffer",
        1,
        65_536,
    )?;
    Ok(())
}

pub(super) fn validate_server_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_optional_string_field(section, "server.host", "host")?;
    validate_string_array_field(section, "server.allowed_origins", "allowed_origins")?;
    validate_string_array_field(
        section,
        "server.cors_allowed_origins",
        "cors_allowed_origins",
    )?;
    validate_string_array_field(section, "server.ws_allowed_origins", "ws_allowed_origins")?;
    Ok(())
}

pub(super) fn validate_privacy_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_bool_field(section, "privacy.allow_web_search", "allow_web_search")?;
    validate_bool_field(section, "privacy.isolation_mode", "isolation_mode")?;
    validate_string_array_field(section, "privacy.url_denylist", "url_denylist")?;
    validate_string_enum_field(
        section,
        "privacy.url_policy_preset",
        "url_policy_preset",
        &["strict", "balanced", "permissive"],
    )?;
    if let Some(lockdown) = expect_optional_object(section, "lockdown")? {
        validate_bool_field(lockdown, "privacy.lockdown.enabled", "enabled")?;
        validate_optional_string_field(lockdown, "privacy.lockdown.updated_at", "updated_at")?;
        validate_optional_string_field(lockdown, "privacy.lockdown.reason", "reason")?;
    }
    Ok(())
}

pub(super) fn validate_search_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_bool_field(section, "search.embedding_rerank", "embedding_rerank")
}

pub(super) fn validate_rag_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_u64_field(
        section,
        "rag.search_default_limit",
        "search_default_limit",
        1,
        20,
    )?;
    validate_u64_field(
        section,
        "rag.text_search_default_limit",
        "text_search_default_limit",
        1,
        50,
    )?;
    validate_u64_field(
        section,
        "rag.embedding_timeout_ms",
        "embedding_timeout_ms",
        1,
        3_600_000,
    )?;
    validate_u64_field(
        section,
        "rag.chunk_window_default_chars",
        "chunk_window_default_chars",
        128,
        20_000,
    )?;
    Ok(())
}

pub(super) fn validate_agent_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_u64_field(section, "agent.max_attachments", "max_attachments", 1, 100)?;
    validate_u64_field(
        section,
        "agent.attachment_preview_chars",
        "attachment_preview_chars",
        1,
        1_000_000,
    )?;
    Ok(())
}

pub(super) fn validate_tools_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_string_enum_field(
        section,
        "tools.search_provider",
        "search_provider",
        &["google", "duckduckgo", "brave", "bing"],
    )?;
    validate_optional_string_field(
        section,
        "tools.brave_search_api_key",
        "brave_search_api_key",
    )?;
    validate_optional_string_field(section, "tools.bing_search_api_key", "bing_search_api_key")?;
    validate_optional_string_field(
        section,
        "tools.google_search_api_key",
        "google_search_api_key",
    )?;
    validate_optional_string_field(
        section,
        "tools.google_search_engine_id",
        "google_search_engine_id",
    )?;
    Ok(())
}

pub(super) fn validate_model_download_section(
    section: &Map<String, Value>,
) -> Result<(), ApiError> {
    validate_bool_field(
        section,
        "model_download.require_allowlist",
        "require_allowlist",
    )?;
    validate_bool_field(
        section,
        "model_download.warn_on_unlisted",
        "warn_on_unlisted",
    )?;
    validate_bool_field(
        section,
        "model_download.require_revision",
        "require_revision",
    )?;
    validate_bool_field(section, "model_download.require_sha256", "require_sha256")?;
    validate_string_array_field(
        section,
        "model_download.allow_repo_owners",
        "allow_repo_owners",
    )?;
    Ok(())
}

pub(super) fn validate_permissions_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_u64_field(
        section,
        "permissions.default_ttl_seconds",
        "default_ttl_seconds",
        60,
        31_536_000,
    )?;
    validate_permission_map(section, "permissions.native_tools", "native_tools")?;
    validate_permission_map(section, "permissions.mcp_servers", "mcp_servers")?;
    Ok(())
}

pub(super) fn validate_credentials_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    for (provider, value) in section {
        let path_prefix = format!("credentials.{}", provider);
        let entry = value
            .as_object()
            .ok_or_else(|| config_type_error(&path_prefix, "object"))?;
        validate_optional_string_field(
            entry,
            &format!("{}.expires_at", path_prefix),
            "expires_at",
        )?;
        validate_optional_string_field(
            entry,
            &format!("{}.last_rotated_at", path_prefix),
            "last_rotated_at",
        )?;
        validate_optional_string_field(entry, &format!("{}.status", path_prefix), "status")?;
    }
    Ok(())
}

pub(super) fn validate_backup_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_bool_field(section, "backup.enable_restore", "enable_restore")?;
    validate_u64_field(
        section,
        "backup.startup_auto_backup_limit",
        "startup_auto_backup_limit",
        1,
        1_000,
    )?;
    validate_bool_field(
        section,
        "backup.include_chat_history",
        "include_chat_history",
    )?;
    validate_bool_field(section, "backup.include_settings", "include_settings")?;
    validate_bool_field(section, "backup.include_characters", "include_characters")?;
    validate_bool_field(section, "backup.include_executors", "include_executors")?;
    if let Some(encryption) = expect_optional_object(section, "encryption")? {
        validate_bool_field(encryption, "backup.encryption.enabled", "enabled")?;
        validate_optional_string_field(encryption, "backup.encryption.algorithm", "algorithm")?;
    }
    Ok(())
}

pub(super) fn validate_quarantine_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_bool_field(section, "quarantine.enabled", "enabled")?;
    validate_bool_field(section, "quarantine.required", "required")?;
    validate_string_array_field(
        section,
        "quarantine.required_transports",
        "required_transports",
    )?;
    Ok(())
}

pub(super) fn validate_models_section(
    root: &Map<String, Value>,
    models_key: &str,
) -> Result<(), ApiError> {
    let Some(models_config) = expect_optional_object(root, models_key)? else {
        return Ok(());
    };

    for (model_name, value) in models_config {
        let path_prefix = format!("{}.{}", models_key, model_name);
        let entry = value
            .as_object()
            .ok_or_else(|| config_type_error(&path_prefix, "object"))?;
        validate_required_string_field(entry, &format!("{}.path", path_prefix), "path")?;
        validate_u64_field(entry, &format!("{}.port", path_prefix), "port", 1, 65535)?;
        validate_u64_field(
            entry,
            &format!("{}.n_ctx", path_prefix),
            "n_ctx",
            1,
            10_000_000,
        )?;
        validate_i64_field(
            entry,
            &format!("{}.n_gpu_layers", path_prefix),
            "n_gpu_layers",
            -1,
            1_000_000,
        )?;
        validate_sampling_config(entry, &path_prefix)?;
        validate_optional_string_field(
            entry,
            &format!("{}.tokenizer_path", path_prefix),
            "tokenizer_path",
        )?;
        validate_optional_string_field(
            entry,
            &format!("{}.tokenizer_format", path_prefix),
            "tokenizer_format",
        )?;
        validate_optional_string_field(
            entry,
            &format!("{}.loader_specific_settings", path_prefix),
            "loader_specific_settings",
        )?;
    }
    Ok(())
}

pub(super) fn validate_llm_defaults_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    validate_sampling_config(section, "llm_defaults")
}

pub(super) fn validate_characters_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    for (character_id, value) in section {
        let path_prefix = format!("characters.{}", character_id);
        let entry = value
            .as_object()
            .ok_or_else(|| config_type_error(&path_prefix, "object"))?;
        validate_optional_string_field(entry, &format!("{}.name", path_prefix), "name")?;
        validate_optional_string_field(
            entry,
            &format!("{}.description", path_prefix),
            "description",
        )?;
        validate_optional_string_field(
            entry,
            &format!("{}.system_prompt", path_prefix),
            "system_prompt",
        )?;
        validate_optional_string_field(entry, &format!("{}.icon", path_prefix), "icon")?;
        validate_optional_string_field(
            entry,
            &format!("{}.avatar_path", path_prefix),
            "avatar_path",
        )?;
    }
    Ok(())
}

pub(super) fn validate_agent_skills_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    if let Some(value) = section.get("roots") {
        let Some(roots) = value.as_array() else {
            return Err(config_type_error("agent_skills.roots", "array"));
        };
        for (index, root_value) in roots.iter().enumerate() {
            let path_prefix = format!("agent_skills.roots[{}]", index);
            let root_entry = root_value
                .as_object()
                .ok_or_else(|| config_type_error(&path_prefix, "object"))?;
            validate_required_string_field(root_entry, &format!("{}.path", path_prefix), "path")?;
            validate_bool_field(root_entry, &format!("{}.enabled", path_prefix), "enabled")?;
            validate_optional_string_field(root_entry, &format!("{}.label", path_prefix), "label")?;
        }
    }
    Ok(())
}

pub(super) fn validate_features_section(section: &Map<String, Value>) -> Result<(), ApiError> {
    if let Some(redesign) = expect_optional_object(section, "redesign")? {
        for (key, value) in redesign {
            if key == "transport_mode" {
                let Some(mode) = value.as_str() else {
                    return Err(ApiError::BadRequest(
                        "Invalid config at 'features.redesign.transport_mode': expected string ('ipc' or 'websocket')".to_string(),
                    ));
                };
                if mode != "ipc" && mode != "websocket" {
                    return Err(ApiError::BadRequest(
                        "Invalid config at 'features.redesign.transport_mode': must be 'ipc' or 'websocket'".to_string(),
                    ));
                }
                continue;
            }
            if !value.is_boolean() {
                return Err(config_type_error(
                    &format!("features.redesign.{}", key),
                    "boolean",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn validate_context_window_section(
    section: &Map<String, Value>,
) -> Result<(), ApiError> {
    validate_context_window_config(section, "context_window")
}

fn validate_permission_map(
    root: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<(), ApiError> {
    let Some(value) = root.get(key) else {
        return Ok(());
    };
    let Some(section) = value.as_object() else {
        return Err(config_type_error(path, "object"));
    };
    for (name, entry) in section {
        let entry_path = format!("{}.{}", path, name);
        let entry = entry
            .as_object()
            .ok_or_else(|| config_type_error(&entry_path, "object"))?;
        validate_string_enum_field(
            entry,
            &format!("{}.decision", entry_path),
            "decision",
            &["deny", "once", "always_until_expiry"],
        )?;
        validate_optional_string_field(entry, &format!("{}.expires_at", entry_path), "expires_at")?;
        validate_optional_string_field(entry, &format!("{}.created_at", entry_path), "created_at")?;
        validate_optional_string_field(entry, &format!("{}.updated_at", entry_path), "updated_at")?;
    }
    Ok(())
}

fn validate_sampling_config(
    section: &Map<String, Value>,
    path_prefix: &str,
) -> Result<(), ApiError> {
    validate_number_field(
        section,
        &format!("{}.temperature", path_prefix),
        "temperature",
    )?;
    validate_number_field(section, &format!("{}.top_p", path_prefix), "top_p")?;
    validate_i64_field(
        section,
        &format!("{}.top_k", path_prefix),
        "top_k",
        0,
        1_000_000,
    )?;
    validate_number_field(
        section,
        &format!("{}.repeat_penalty", path_prefix),
        "repeat_penalty",
    )?;
    validate_i64_field(
        section,
        &format!("{}.max_tokens", path_prefix),
        "max_tokens",
        1,
        1_000_000,
    )?;
    validate_i64_field(
        section,
        &format!("{}.predict_len", path_prefix),
        "predict_len",
        1,
        1_000_000,
    )?;
    validate_string_array_field(section, &format!("{}.stop", path_prefix), "stop")?;
    validate_i64_field(
        section,
        &format!("{}.seed", path_prefix),
        "seed",
        i64::MIN,
        i64::MAX,
    )?;
    validate_number_field(
        section,
        &format!("{}.frequency_penalty", path_prefix),
        "frequency_penalty",
    )?;
    validate_number_field(
        section,
        &format!("{}.presence_penalty", path_prefix),
        "presence_penalty",
    )?;
    validate_number_field(section, &format!("{}.min_p", path_prefix), "min_p")?;
    validate_number_field(section, &format!("{}.tfs_z", path_prefix), "tfs_z")?;
    validate_number_field(section, &format!("{}.typical_p", path_prefix), "typical_p")?;
    validate_i64_field(
        section,
        &format!("{}.mirostat", path_prefix),
        "mirostat",
        0,
        100,
    )?;
    validate_number_field(
        section,
        &format!("{}.mirostat_tau", path_prefix),
        "mirostat_tau",
    )?;
    validate_number_field(
        section,
        &format!("{}.mirostat_eta", path_prefix),
        "mirostat_eta",
    )?;
    validate_i64_field(
        section,
        &format!("{}.repeat_last_n", path_prefix),
        "repeat_last_n",
        -1,
        1_000_000,
    )?;
    validate_bool_field(
        section,
        &format!("{}.penalize_nl", path_prefix),
        "penalize_nl",
    )?;
    validate_i64_field(
        section,
        &format!("{}.n_keep", path_prefix),
        "n_keep",
        -1,
        1_000_000,
    )?;
    validate_bool_field(
        section,
        &format!("{}.cache_prompt", path_prefix),
        "cache_prompt",
    )?;
    validate_i64_field(
        section,
        &format!("{}.num_ctx", path_prefix),
        "num_ctx",
        1,
        10_000_000,
    )?;
    Ok(())
}

fn validate_context_window_config(
    section: &Map<String, Value>,
    path_prefix: &str,
) -> Result<(), ApiError> {
    for (key, value) in section {
        let entry_path = format!("{}.{}", path_prefix, key);
        let entry = value
            .as_object()
            .ok_or_else(|| config_type_error(&entry_path, "object"))?;
        if is_context_window_recipe(entry) {
            validate_context_window_recipe(entry, &entry_path)?;
            continue;
        }
        for (nested_key, nested_value) in entry {
            let nested_path = format!("{}.{}", entry_path, nested_key);
            let nested = nested_value
                .as_object()
                .ok_or_else(|| config_type_error(&nested_path, "object"))?;
            validate_context_window_recipe(nested, &nested_path)?;
        }
    }
    Ok(())
}

fn is_context_window_recipe(section: &Map<String, Value>) -> bool {
    section.keys().any(|key| {
        matches!(
            key.as_str(),
            "system_cap"
                | "memory_cap"
                | "local_context_cap"
                | "interaction_tail_cap"
                | "evidence_cap"
                | "artifact_summary_cap"
                | "app_thinking_digest_cap"
                | "model_thinking_digest_cap"
                | "user_input_cap"
                | "evidence_limit"
                | "artifact_limit"
        )
    })
}

fn validate_context_window_recipe(
    section: &Map<String, Value>,
    path_prefix: &str,
) -> Result<(), ApiError> {
    for field in [
        "system_cap",
        "memory_cap",
        "local_context_cap",
        "interaction_tail_cap",
        "evidence_cap",
        "artifact_summary_cap",
        "app_thinking_digest_cap",
        "model_thinking_digest_cap",
        "user_input_cap",
    ] {
        validate_u64_field(
            section,
            &format!("{}.{}", path_prefix, field),
            field,
            0,
            100,
        )?;
    }
    validate_u64_field(
        section,
        &format!("{}.evidence_limit", path_prefix),
        "evidence_limit",
        0,
        100,
    )?;
    validate_u64_field(
        section,
        &format!("{}.artifact_limit", path_prefix),
        "artifact_limit",
        0,
        100,
    )?;
    Ok(())
}
