use crate::core::errors::ApiError;
use serde_json::{Map, Value};

pub(super) fn expect_optional_object<'a>(
    root: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a Map<String, Value>>, ApiError> {
    match root.get(key) {
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(_) => Err(config_type_error(key, "object")),
        None => Ok(None),
    }
}

pub(super) fn validate_bool_field(
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

pub(super) fn validate_u64_field(
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

pub(super) fn validate_number_field(
    section: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<(), ApiError> {
    let Some(value) = section.get(key) else {
        return Ok(());
    };
    if value.as_f64().is_some() {
        return Ok(());
    }
    Err(config_type_error(path, "number"))
}

pub(super) fn validate_i64_field(
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

pub(super) fn validate_required_string_field(
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

pub(super) fn validate_optional_string_field(
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

pub(super) fn validate_string_array_field(
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

pub(super) fn validate_string_enum_field(
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
    if allowed.contains(&text) {
        return Ok(());
    }
    Err(ApiError::BadRequest(format!(
        "Invalid config at '{}': expected one of {}",
        path,
        allowed.join(", ")
    )))
}

pub(super) fn config_type_error(path: &str, expected: &str) -> ApiError {
    ApiError::BadRequest(format!(
        "Invalid config at '{}': expected {}",
        path, expected
    ))
}
