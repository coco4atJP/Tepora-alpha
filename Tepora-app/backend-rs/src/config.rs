use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::errors::ApiError;

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

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub project_root: PathBuf,
    pub user_data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub db_path: PathBuf,
    #[allow(dead_code)]
    pub chroma_dir: PathBuf,
    pub secrets_path: PathBuf,
}

impl AppPaths {
    pub fn new() -> Self {
        let project_root = discover_project_root();
        let user_data_dir = discover_user_data_dir(&project_root);
        let log_dir = user_data_dir.join("logs");
        let db_path = user_data_dir.join("tepora_chat.db");
        let chroma_dir = user_data_dir.join("chroma_db");
        let secrets_path = user_data_dir.join("secrets.yaml");

        for dir in [&user_data_dir, &log_dir, &chroma_dir] {
            let _ = fs::create_dir_all(dir);
        }

        AppPaths {
            project_root,
            user_data_dir,
            log_dir,
            db_path,
            chroma_dir,
            secrets_path,
        }
    }
}

fn discover_project_root() -> PathBuf {
    if let Ok(root) = env::var("TEPORA_ROOT") {
        return PathBuf::from(root);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if manifest_dir.join("config.yml").exists() {
        return manifest_dir;
    }

    let sibling_backend = manifest_dir.join("..").join("backend");
    if sibling_backend.join("config.yml").exists() {
        return sibling_backend;
    }

    env::current_dir().unwrap_or(manifest_dir)
}

fn discover_user_data_dir(project_root: &Path) -> PathBuf {
    if let Ok(dir) = env::var("TEPORA_DATA_DIR") {
        return PathBuf::from(dir);
    }

    if cfg!(debug_assertions) {
        return project_root.to_path_buf();
    }

    if cfg!(target_os = "windows") {
        let base = env::var("LOCALAPPDATA")
            .unwrap_or_else(|_| env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string()));
        return PathBuf::from(base).join("Tepora");
    }

    if cfg!(target_os = "macos") {
        return home_dir()
            .join("Library")
            .join("Application Support")
            .join("Tepora");
    }

    let xdg = env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
        home_dir()
            .join(".local/share")
            .to_string_lossy()
            .to_string()
    });
    PathBuf::from(xdg).join("tepora")
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

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

        // TODO: Port full schema validation. For now accept any mapping.
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

    #[test]
    fn restore_redacted_values_uses_original_on_placeholders() {
        let original = json!({
            "api_key": "secret",
            "nested": { "token": "abc", "name": "old" },
            "items": ["keep", "orig"]
        });
        let updated = json!({
            "api_key": "****",
            "nested": { "token": "****", "name": "new" },
            "items": ["****", "fresh"]
        });

        let restored = restore_redacted_values(&updated, &original);

        assert_eq!(
            restored,
            json!({
                "api_key": "secret",
                "nested": { "token": "abc", "name": "new" },
                "items": ["keep", "fresh"]
            })
        );
    }
}
