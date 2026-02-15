use serde_json::{Map, Value};
use crate::core::errors::ApiError;

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

fn config_type_error(path: &str, expected: &str) -> ApiError {
    ApiError::BadRequest(format!(
        "Invalid config at '{}': expected {}",
        path, expected
    ))
}
