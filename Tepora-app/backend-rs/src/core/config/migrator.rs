use serde_json::{Map, Number, Value};

use crate::core::errors::ApiError;

use super::secrets::{materialize_sensitive_references, SecretStore};

pub const CURRENT_SCHEMA_VERSION: u64 = 2;

pub fn migrate_to_current(
    config: &mut Value,
    secret_store: &dyn SecretStore,
) -> Result<bool, ApiError> {
    let current_version = parse_schema_version(config)?;
    if current_version > CURRENT_SCHEMA_VERSION {
        return Err(ApiError::BadRequest(format!(
            "Unsupported config schema_version={} (current={CURRENT_SCHEMA_VERSION})",
            current_version
        )));
    }

    let mut changed = false;

    if current_version < 1 {
        changed = true;
    }
    if current_version < 2 {
        changed |= migrate_to_v2(config)?;
    }

    set_schema_version(config, CURRENT_SCHEMA_VERSION)?;
    if materialize_sensitive_references(config, secret_store)? {
        changed = true;
    }

    Ok(changed)
}

fn migrate_to_v2(config: &mut Value) -> Result<bool, ApiError> {
    let Some(root) = ensure_root_object(config) else {
        return Ok(false);
    };
    let mut changed = false;

    let model_download = ensure_object(root, "model_download");
    if !model_download.contains_key("require_sha256") {
        model_download.insert("require_sha256".to_string(), Value::Bool(true));
        changed = true;
    }

    let permissions = ensure_object(root, "permissions");
    if !permissions.contains_key("default_ttl_seconds") {
        permissions.insert(
            "default_ttl_seconds".to_string(),
            Value::Number(Number::from(86_400_u64)),
        );
        changed = true;
    }
    if !permissions.contains_key("native_tools") {
        permissions.insert("native_tools".to_string(), Value::Object(Map::new()));
        changed = true;
    }
    if !permissions.contains_key("mcp_servers") {
        permissions.insert("mcp_servers".to_string(), Value::Object(Map::new()));
        changed = true;
    }

    let privacy = ensure_object(root, "privacy");
    if !privacy.contains_key("url_policy_preset") {
        privacy.insert(
            "url_policy_preset".to_string(),
            Value::String("balanced".to_string()),
        );
        changed = true;
    }
    if !privacy.contains_key("lockdown") {
        privacy.insert(
            "lockdown".to_string(),
            serde_json::json!({
                "enabled": false,
                "updated_at": null,
                "reason": null,
            }),
        );
        changed = true;
    }

    Ok(changed)
}

fn parse_schema_version(config: &Value) -> Result<u64, ApiError> {
    let Some(root) = config.as_object() else {
        return Ok(0);
    };

    let Some(version_value) = root.get("schema_version") else {
        return Ok(0);
    };

    if version_value.is_null() {
        return Ok(0);
    }

    match version_value.as_u64() {
        Some(version) => Ok(version),
        None => Err(ApiError::BadRequest(
            "config.schema_version must be an unsigned integer".to_string(),
        )),
    }
}

fn set_schema_version(config: &mut Value, version: u64) -> Result<(), ApiError> {
    let Some(root) = ensure_root_object(config) else {
        return Err(ApiError::BadRequest("config root must be an object".to_string()));
    };

    root.insert(
        "schema_version".to_string(),
        Value::Number(Number::from(version)),
    );
    Ok(())
}

fn ensure_root_object(config: &mut Value) -> Option<&mut Map<String, Value>> {
    if !config.is_object() {
        *config = Value::Object(Map::new());
    }
    config.as_object_mut()
}

fn ensure_object<'a>(root: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = root
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object ensured")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{migrate_to_current, CURRENT_SCHEMA_VERSION};
    use crate::core::config::secrets::{is_keyring_reference, MemorySecretStore};

    #[test]
    fn migrate_v0_to_v2_sets_schema_and_materializes_secrets() {
        let store = MemorySecretStore::default();
        let mut config = json!({
            "llm": {
                "api_key": "top-secret"
            }
        });

        let changed = migrate_to_current(&mut config, &store).expect("migration should succeed");
        assert!(changed);
        assert_eq!(
            config.get("schema_version").and_then(|v| v.as_u64()),
            Some(CURRENT_SCHEMA_VERSION)
        );

        let reference = config
            .get("llm")
            .and_then(|v| v.get("api_key"))
            .and_then(|v| v.as_str())
            .expect("api_key should be string");
        assert!(is_keyring_reference(reference));
        assert_eq!(
            config
                .get("model_download")
                .and_then(|v| v.get("require_sha256"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn migrate_preserves_explicit_sha_setting() {
        let store = MemorySecretStore::default();
        let mut config = json!({
            "schema_version": 1,
            "model_download": {
                "require_sha256": false
            }
        });

        migrate_to_current(&mut config, &store).expect("migration should succeed");
        assert_eq!(
            config
                .get("model_download")
                .and_then(|v| v.get("require_sha256"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
    }
}
