use crate::core::errors::ApiError;
use serde_json::{Map, Value};

pub fn validate_config(config: &Value) -> Result<(), ApiError> {
    let root = config
        .as_object()
        .ok_or_else(|| config_type_error("root", "object"))?;

    if let Some(app) = expect_optional_object(root, "app")? {
        validate_u64_field(
            app,
            "app.max_input_length",
            "max_input_length",
            1,
            10_000_000,
        )?;
        validate_u64_field(
            app,
            "app.graph_recursion_limit",
            "graph_recursion_limit",
            1,
            10_000,
        )?;
        validate_u64_field(
            app,
            "app.tool_execution_timeout",
            "tool_execution_timeout",
            1,
            86_400,
        )?;
        validate_u64_field(
            app,
            "app.tool_approval_timeout",
            "tool_approval_timeout",
            1,
            86_400,
        )?;
        validate_u64_field(
            app,
            "app.web_fetch_max_chars",
            "web_fetch_max_chars",
            1,
            5_000_000,
        )?;
        validate_u64_field(
            app,
            "app.web_fetch_timeout_secs",
            "web_fetch_timeout_secs",
            1,
            86_400,
        )?;
        validate_u64_field(
            app,
            "app.web_fetch_max_bytes",
            "web_fetch_max_bytes",
            1,
            100_000_000,
        )?;
        validate_u64_field(
            app,
            "app.graph_execution_timeout",
            "graph_execution_timeout",
            1_000,
            3_600_000, // 1 hour
        )?;
    }

    if let Some(server) = expect_optional_object(root, "server")? {
        validate_optional_string_field(server, "server.host", "host")?;
        validate_string_array_field(server, "server.allowed_origins", "allowed_origins")?;
        validate_string_array_field(
            server,
            "server.cors_allowed_origins",
            "cors_allowed_origins",
        )?;
        validate_string_array_field(server, "server.ws_allowed_origins", "ws_allowed_origins")?;
    }

    if let Some(privacy) = expect_optional_object(root, "privacy")? {
        validate_bool_field(privacy, "privacy.allow_web_search", "allow_web_search")?;
        validate_string_array_field(privacy, "privacy.url_denylist", "url_denylist")?;
        validate_string_enum_field(
            privacy,
            "privacy.url_policy_preset",
            "url_policy_preset",
            &["strict", "balanced", "permissive"],
        )?;
        if let Some(lockdown) = expect_optional_object(privacy, "lockdown")? {
            validate_bool_field(lockdown, "privacy.lockdown.enabled", "enabled")?;
            validate_optional_string_field(lockdown, "privacy.lockdown.updated_at", "updated_at")?;
            validate_optional_string_field(lockdown, "privacy.lockdown.reason", "reason")?;
        }
    }

    if let Some(search) = expect_optional_object(root, "search")? {
        validate_bool_field(search, "search.embedding_rerank", "embedding_rerank")?;
    }

    if let Some(download) = expect_optional_object(root, "model_download")? {
        validate_bool_field(
            download,
            "model_download.require_allowlist",
            "require_allowlist",
        )?;
        validate_bool_field(
            download,
            "model_download.warn_on_unlisted",
            "warn_on_unlisted",
        )?;
        validate_bool_field(
            download,
            "model_download.require_revision",
            "require_revision",
        )?;
        validate_bool_field(download, "model_download.require_sha256", "require_sha256")?;
        validate_string_array_field(
            download,
            "model_download.allow_repo_owners",
            "allow_repo_owners",
        )?;
    }

    if let Some(permissions) = expect_optional_object(root, "permissions")? {
        validate_u64_field(
            permissions,
            "permissions.default_ttl_seconds",
            "default_ttl_seconds",
            60,
            31_536_000,
        )?;
        validate_permission_section(permissions, "permissions.native_tools", "native_tools")?;
        validate_permission_section(permissions, "permissions.mcp_servers", "mcp_servers")?;
    }

    if let Some(credentials) = expect_optional_object(root, "credentials")? {
        for (provider, value) in credentials {
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
    }

    if let Some(backup) = expect_optional_object(root, "backup")? {
        validate_bool_field(backup, "backup.enable_restore", "enable_restore")?;
        validate_u64_field(
            backup,
            "backup.startup_auto_backup_limit",
            "startup_auto_backup_limit",
            1,
            1_000,
        )?;
        validate_bool_field(
            backup,
            "backup.include_chat_history",
            "include_chat_history",
        )?;
        validate_bool_field(backup, "backup.include_settings", "include_settings")?;
        validate_bool_field(backup, "backup.include_characters", "include_characters")?;
        validate_bool_field(backup, "backup.include_executors", "include_executors")?;
        if let Some(encryption) = expect_optional_object(backup, "encryption")? {
            validate_bool_field(encryption, "backup.encryption.enabled", "enabled")?;
            validate_optional_string_field(encryption, "backup.encryption.algorithm", "algorithm")?;
        }
    }

    if let Some(quarantine) = expect_optional_object(root, "quarantine")? {
        validate_bool_field(quarantine, "quarantine.enabled", "enabled")?;
        validate_bool_field(quarantine, "quarantine.required", "required")?;
        validate_string_array_field(
            quarantine,
            "quarantine.required_transports",
            "required_transports",
        )?;
    }

    if let Some(models_gguf) = expect_optional_object(root, "models_gguf")? {
        for (model_name, value) in models_gguf {
            let path_prefix = format!("models_gguf.{}", model_name);
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
        }
    }

    if let Some(characters) = expect_optional_object(root, "characters")? {
        for (character_id, value) in characters {
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
    }

    if let Some(agent_skills) = expect_optional_object(root, "agent_skills")? {
        if let Some(value) = agent_skills.get("roots") {
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
    }

    if let Some(features) = expect_optional_object(root, "features")? {
        if let Some(redesign) = expect_optional_object(features, "redesign")? {
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
    }

    Ok(())
}

fn expect_optional_object<'a>(
    root: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a Map<String, Value>>, ApiError> {
    match root.get(key) {
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(_) => Err(config_type_error(key, "object")),
        None => Ok(None),
    }
}

fn validate_bool_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<(), ApiError> {
    let Some(value) = section.get(key) else {
        return Ok(());
    };
    if value.as_bool().is_some() {
        return Ok(());
    }
    Err(config_type_error(path, "boolean"))
}

fn validate_u64_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
    min: u64,
    max: u64,
) -> Result<(), ApiError> {
    let Some(value) = section.get(key) else {
        return Ok(());
    };
    let Some(number) = value.as_u64() else {
        return Err(config_type_error(path, "integer"));
    };
    if number < min || number > max {
        return Err(ApiError::BadRequest(format!(
            "Invalid config at '{}': must be between {} and {}",
            path, min, max
        )));
    }
    Ok(())
}

fn validate_i64_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
    min: i64,
    max: i64,
) -> Result<(), ApiError> {
    let Some(value) = section.get(key) else {
        return Ok(());
    };
    let Some(number) = value.as_i64() else {
        return Err(config_type_error(path, "integer"));
    };
    if number < min || number > max {
        return Err(ApiError::BadRequest(format!(
            "Invalid config at '{}': must be between {} and {}",
            path, min, max
        )));
    }
    Ok(())
}

fn validate_required_string_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<(), ApiError> {
    let value = section.get(key).ok_or_else(|| {
        ApiError::BadRequest(format!("Invalid config at '{}': value is required", path))
    })?;
    let Some(text) = value.as_str() else {
        return Err(config_type_error(path, "string"));
    };
    if text.trim().is_empty() {
        return Err(ApiError::BadRequest(format!(
            "Invalid config at '{}': value cannot be empty",
            path
        )));
    }
    Ok(())
}

fn validate_optional_string_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<(), ApiError> {
    let Some(value) = section.get(key) else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    if value.as_str().is_none() {
        return Err(config_type_error(path, "string"));
    }
    Ok(())
}

fn validate_string_array_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<(), ApiError> {
    let Some(value) = section.get(key) else {
        return Ok(());
    };
    let Some(items) = value.as_array() else {
        return Err(config_type_error(path, "array of strings"));
    };
    for (index, item) in items.iter().enumerate() {
        let Some(text) = item.as_str() else {
            return Err(config_type_error(&format!("{}[{}]", path, index), "string"));
        };
        if text.trim().is_empty() {
            return Err(ApiError::BadRequest(format!(
                "Invalid config at '{}[{}]': value cannot be empty",
                path, index
            )));
        }
    }
    Ok(())
}

fn validate_string_enum_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
    allowed: &[&str],
) -> Result<(), ApiError> {
    let Some(value) = section.get(key) else {
        return Ok(());
    };
    let Some(text) = value.as_str() else {
        return Err(config_type_error(path, "string"));
    };
    if allowed.iter().any(|item| *item == text) {
        return Ok(());
    }
    Err(ApiError::BadRequest(format!(
        "Invalid config at '{}': expected one of {}",
        path,
        allowed.join(", ")
    )))
}

fn validate_permission_section(
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

fn config_type_error(path: &str, expected: &str) -> ApiError {
    ApiError::BadRequest(format!(
        "Invalid config at '{}': expected {}",
        path, expected
    ))
}
