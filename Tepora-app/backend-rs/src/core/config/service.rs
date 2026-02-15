use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};

use super::paths::AppPaths;
use super::validation::validate_config;
use crate::core::errors::ApiError;

const REDACT_PLACEHOLDER: &str = "****";

const SENSITIVE_PATTERNS: [&str; 18] = [
    "api_key",
    "secret",
    "password",
    "_token",
    "token_",
    "credential",
    "private_key",
    "auth_",
    "_auth",
    "oauth",
    "jwt",
    "access_key",
    "client_id",
    "client_secret",
    "access_token",
    "refresh_token",
    "auth_token",
    "bearer",
];

const SENSITIVE_WHITELIST: [&str; 7] = [
    "max_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "token_count",
    "tokenizer",
    "tokens",
];

#[derive(Clone)]
pub struct ConfigService {
    paths: Arc<AppPaths>,
}

impl ConfigService {
    pub fn new(paths: Arc<AppPaths>) -> Self {
        Self { paths }
    }

    #[allow(dead_code)]
    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    pub fn config_path(&self) -> PathBuf {
        if let Ok(path) = env::var("TEPORA_CONFIG_PATH") {
            return PathBuf::from(path);
        }

        let user_config = self.paths.user_data_dir.join("config.yml");
        if user_config.exists() {
            return user_config;
        }

        self.paths.project_root.join("config.yml")
    }

    pub fn config_write_path(&self) -> PathBuf {
        if let Ok(path) = env::var("TEPORA_CONFIG_PATH") {
            return PathBuf::from(path);
        }

        self.paths.user_data_dir.join("config.yml")
    }

    pub fn secrets_path(&self) -> PathBuf {
        self.paths.secrets_path.clone()
    }

    pub fn load_config(&self) -> Result<Value, ApiError> {
        let public_config = load_yaml_file(&self.config_path());
        let secrets_config = load_yaml_file(&self.secrets_path());
        let merged = deep_merge(&public_config, &secrets_config);
        Ok(merged)
    }

    pub fn update_config(&self, config_data: Value, merge: bool) -> Result<(), ApiError> {
        let current = self.load_config()?;
        let restored = restore_redacted_values(&config_data, &current);
        let to_save = if merge {
            deep_merge(&current, &restored)
        } else {
            restored
        };

        validate_config(&to_save)?;
        save_config_files(self, &to_save)?;
        Ok(())
    }

    pub fn redact_sensitive_values(&self, value: &Value) -> Value {
        redact_sensitive_values(value)
    }
}

fn load_yaml_file(path: &Path) -> Value {
    if !path.exists() {
        return Value::Object(Map::new());
    }

    match fs::read_to_string(path) {
        Ok(contents) => match serde_yaml::from_str::<Value>(&contents) {
            Ok(value) => match value {
                Value::Object(_) => value,
                _ => Value::Object(Map::new()),
            },
            Err(_) => Value::Object(Map::new()),
        },
        Err(_) => Value::Object(Map::new()),
    }
}

fn save_config_files(service: &ConfigService, config: &Value) -> Result<(), ApiError> {
    let (public_config, secrets_config) = split_config(config);

    let config_path = service.config_write_path();
    if let Some(parent) = config_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let public_yaml = serde_yaml::to_string(&public_config).map_err(ApiError::internal)?;
    fs::write(&config_path, public_yaml).map_err(ApiError::internal)?;

    let secrets_path = service.secrets_path();
    if let Some(parent) = secrets_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let secrets_yaml = serde_yaml::to_string(&secrets_config).map_err(ApiError::internal)?;
    fs::write(&secrets_path, secrets_yaml).map_err(ApiError::internal)?;

    Ok(())
}

fn deep_merge(base: &Value, override_value: &Value) -> Value {
    match (base, override_value) {
        (Value::Object(base_map), Value::Object(override_map)) => {
            let mut merged: Map<String, Value> = base_map.clone();
            for (key, value) in override_map {
                let merged_value = match merged.get(key) {
                    Some(existing) => deep_merge(existing, value),
                    None => value.clone(),
                };
                merged.insert(key.clone(), merged_value);
            }
            Value::Object(merged)
        }
        _ => override_value.clone(),
    }
}

fn split_config(config: &Value) -> (Value, Value) {
    match config {
        Value::Object(map) => {
            let mut public_map = Map::new();
            let mut secret_map = Map::new();

            for (key, value) in map {
                match value {
                    Value::Object(_) => {
                        let (public_sub, secret_sub) = split_config(value);
                        if !is_empty_object(&public_sub) {
                            public_map.insert(key.clone(), public_sub);
                        }
                        if !is_empty_object(&secret_sub) {
                            secret_map.insert(key.clone(), secret_sub);
                        }
                    }
                    _ => {
                        if is_sensitive_key(key) && !value.is_null() {
                            secret_map.insert(key.clone(), value.clone());
                        } else {
                            public_map.insert(key.clone(), value.clone());
                        }
                    }
                }
            }

            (Value::Object(public_map), Value::Object(secret_map))
        }
        _ => (config.clone(), Value::Object(Map::new())),
    }
}

fn redact_sensitive_values(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut redacted = Map::new();
            for (key, val) in map {
                if is_sensitive_key(key) && !val.is_null() {
                    redacted.insert(key.clone(), Value::String(REDACT_PLACEHOLDER.to_string()));
                } else {
                    redacted.insert(key.clone(), redact_sensitive_values(val));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_sensitive_values).collect()),
        _ => value.clone(),
    }
}

fn restore_redacted_values(new_value: &Value, original: &Value) -> Value {
    match new_value {
        Value::Object(map) => {
            let mut restored = Map::new();
            let original_map = original.as_object();

            for (key, value) in map {
                let orig_val = original_map.and_then(|m| m.get(key));
                if value.as_str() == Some(REDACT_PLACEHOLDER) {
                    if let Some(orig) = orig_val {
                        restored.insert(key.clone(), orig.clone());
                    }
                    continue;
                }

                if value.is_object() || value.is_array() {
                    let merged = restore_redacted_values(value, orig_val.unwrap_or(&Value::Null));
                    restored.insert(key.clone(), merged);
                } else {
                    restored.insert(key.clone(), value.clone());
                }
            }

            Value::Object(restored)
        }
        Value::Array(items) => {
            let original_items = original.as_array();
            let restored_items = items
                .iter()
                .enumerate()
                .filter_map(|(idx, item)| {
                    if item.as_str() == Some(REDACT_PLACEHOLDER) {
                        return original_items.and_then(|orig| orig.get(idx)).cloned();
                    }
                    Some(restore_redacted_values(
                        item,
                        original_items
                            .and_then(|orig| orig.get(idx))
                            .unwrap_or(&Value::Null),
                    ))
                })
                .collect();
            Value::Array(restored_items)
        }
        _ => new_value.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key_lower = key.to_lowercase();
    if SENSITIVE_WHITELIST
        .iter()
        .any(|allowed| *allowed == key_lower)
    {
        return false;
    }
    SENSITIVE_PATTERNS
        .iter()
        .any(|pattern| key_lower.contains(pattern))
}

fn is_empty_object(value: &Value) -> bool {
    matches!(value, Value::Object(map) if map.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deep_merge_merges_objects_and_overrides_scalars() {
        let base = json!({
            "a": 1,
            "b": { "c": 2, "d": 3 },
            "arr": [1, 2]
        });
        let override_value = json!({
            "b": { "c": 99 },
            "arr": [3],
            "e": "x"
        });

        let merged = deep_merge(&base, &override_value);

        assert_eq!(
            merged,
            json!({
                "a": 1,
                "b": { "c": 99, "d": 3 },
                "arr": [3],
                "e": "x"
            })
        );
    }

    #[test]
    fn split_config_separates_sensitive_values() {
        let input = json!({
            "api_key": "secret",
            "max_tokens": 100,
            "nested": {
                "auth_token": "token",
                "name": "local"
            }
        });

        let (public_config, secret_config) = split_config(&input);

        assert_eq!(
            public_config,
            json!({
                "max_tokens": 100,
                "nested": { "name": "local" }
            })
        );
        assert_eq!(
            secret_config,
            json!({
                "api_key": "secret",
                "nested": { "auth_token": "token" }
            })
        );
    }

    #[test]
    fn redact_sensitive_values_replaces_secrets_only() {
        let input = json!({
            "api_key": "secret",
            "nested": {
                "refresh_token": "refresh",
                "max_tokens": 42
            },
            "items": [
                { "password": "pw" }
            ]
        });

        let redacted = redact_sensitive_values(&input);

        assert_eq!(
            redacted,
            json!({
                "api_key": "****",
                "nested": {
                    "refresh_token": "****",
                    "max_tokens": 42
                },
                "items": [
                    { "password": "****" }
                ]
            })
        );
    }
}
