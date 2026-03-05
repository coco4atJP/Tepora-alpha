use serde_json::{Map, Number, Value};

use crate::core::errors::ApiError;

use super::secrets::{materialize_sensitive_references, SecretStore};

pub const CURRENT_SCHEMA_VERSION: u64 = 1;

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
        set_schema_version(config, CURRENT_SCHEMA_VERSION)?;
        changed = true;
    }

    if materialize_sensitive_references(config, secret_store)? {
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
    let Some(root) = config.as_object_mut() else {
        *config = Value::Object(Map::new());
        return set_schema_version(config, version);
    };

    root.insert(
        "schema_version".to_string(),
        Value::Number(Number::from(version)),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{migrate_to_current, CURRENT_SCHEMA_VERSION};
    use crate::core::config::secrets::{is_keyring_reference, MemorySecretStore};

    #[test]
    fn migrate_v0_to_v1_sets_schema_and_materializes_secrets() {
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
    }

    #[test]
    fn migrate_rejects_future_schema_version() {
        let store = MemorySecretStore::default();
        let mut config = json!({
            "schema_version": CURRENT_SCHEMA_VERSION + 1,
        });

        let err = migrate_to_current(&mut config, &store).expect_err("future schema must fail");
        assert!(err
            .to_string()
            .contains("Unsupported config schema_version"));
    }

    #[test]
    fn migrate_is_idempotent() {
        let store = MemorySecretStore::default();
        let mut config = json!({
            "llm": {
                "api_key": "top-secret"
            }
        });

        let first = migrate_to_current(&mut config, &store).expect("first migration");
        assert!(first);

        let second = migrate_to_current(&mut config, &store).expect("second migration");
        assert!(!second);
    }
}
