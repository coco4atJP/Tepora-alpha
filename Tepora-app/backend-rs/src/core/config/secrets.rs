use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::core::errors::ApiError;

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

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

const KEYRING_SERVICE: &str = "tepora-config";
const KEYRING_PREFIX: &str = "keyring://tepora/config/";

pub trait SecretStore: Send + Sync {
    fn store_secret(&self, path: &str, secret: &str) -> Result<String, ApiError>;
    fn read_secret(&self, reference: &str) -> Result<Option<String>, ApiError>;
    fn delete_secret(&self, reference: &str) -> Result<(), ApiError>;
}

#[derive(Debug, Default)]
pub struct OsSecretStore;

impl SecretStore for OsSecretStore {
    fn store_secret(&self, path: &str, secret: &str) -> Result<String, ApiError> {
        let reference = build_reference(path);
        let account = reference_to_account(&reference)?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account).map_err(ApiError::internal)?;
        entry.set_password(secret).map_err(ApiError::internal)?;
        Ok(reference)
    }

    fn read_secret(&self, reference: &str) -> Result<Option<String>, ApiError> {
        if !is_keyring_reference(reference) {
            return Ok(Some(reference.to_string()));
        }

        let account = reference_to_account(reference)?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account).map_err(ApiError::internal)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(ApiError::internal(err)),
        }
    }

    fn delete_secret(&self, reference: &str) -> Result<(), ApiError> {
        if !is_keyring_reference(reference) {
            return Ok(());
        }

        let account = reference_to_account(reference)?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account).map_err(ApiError::internal)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(ApiError::internal(err)),
        }
    }
}

pub fn is_sensitive_key(key: &str) -> bool {
    let key_lower = key.to_lowercase();
    if SENSITIVE_WHITELIST.iter().any(|allowed| *allowed == key_lower) {
        return false;
    }

    SENSITIVE_PATTERNS
        .iter()
        .any(|pattern| key_lower.contains(pattern))
}

pub fn is_keyring_reference(value: &str) -> bool {
    value.starts_with(KEYRING_PREFIX)
}

pub fn materialize_sensitive_references(
    value: &mut Value,
    secret_store: &dyn SecretStore,
) -> Result<bool, ApiError> {
    let mut changed = false;
    materialize_walk(value, "", secret_store, &mut changed)?;
    Ok(changed)
}

pub fn resolve_sensitive_references(
    value: &mut Value,
    secret_store: &dyn SecretStore,
) -> Result<(), ApiError> {
    resolve_walk(value, "", secret_store)
}

pub fn rotate_sensitive_references(
    value: &mut Value,
    secret_store: &dyn SecretStore,
) -> Result<usize, ApiError> {
    let mut rotated = 0usize;
    rotate_walk(value, "", secret_store, &mut rotated)?;
    Ok(rotated)
}

fn materialize_walk(
    value: &mut Value,
    path: &str,
    secret_store: &dyn SecretStore,
    changed: &mut bool,
) -> Result<(), ApiError> {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                let next_path = join_path(path, key);
                if is_sensitive_key(key) && !val.is_null() {
                    if let Value::String(raw) = val {
                        if is_keyring_reference(raw) {
                            continue;
                        }
                        let reference = secret_store.store_secret(&next_path, raw)?;
                        *val = Value::String(reference);
                        *changed = true;
                        continue;
                    }

                    let serialized = serde_json::to_string(val).map_err(ApiError::internal)?;
                    let reference = secret_store.store_secret(&next_path, &serialized)?;
                    *val = Value::String(reference);
                    *changed = true;
                    continue;
                }

                materialize_walk(val, &next_path, secret_store, changed)?;
            }
        }
        Value::Array(items) => {
            for (idx, item) in items.iter_mut().enumerate() {
                let next_path = if path.is_empty() {
                    idx.to_string()
                } else {
                    format!("{path}[{idx}]")
                };
                materialize_walk(item, &next_path, secret_store, changed)?;
            }
        }
        _ => {}
    }

    Ok(())
}

fn resolve_walk(value: &mut Value, path: &str, secret_store: &dyn SecretStore) -> Result<(), ApiError> {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                let next_path = join_path(path, key);
                if is_sensitive_key(key) {
                    if let Value::String(raw) = val {
                        if is_keyring_reference(raw) {
                            let secret = secret_store.read_secret(raw)?.ok_or_else(|| {
                                ApiError::Internal(format!(
                                    "Missing keyring secret for reference '{raw}' at '{next_path}'"
                                ))
                            })?;
                            *val = Value::String(secret);
                        }
                    }
                    continue;
                }

                resolve_walk(val, &next_path, secret_store)?;
            }
        }
        Value::Array(items) => {
            for (idx, item) in items.iter_mut().enumerate() {
                let next_path = if path.is_empty() {
                    idx.to_string()
                } else {
                    format!("{path}[{idx}]")
                };
                resolve_walk(item, &next_path, secret_store)?;
            }
        }
        _ => {}
    }

    Ok(())
}

fn rotate_walk(
    value: &mut Value,
    path: &str,
    secret_store: &dyn SecretStore,
    rotated: &mut usize,
) -> Result<(), ApiError> {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                let next_path = join_path(path, key);
                if is_sensitive_key(key) && !val.is_null() {
                    let replacement = match val {
                        Value::String(raw) if is_keyring_reference(raw) => {
                            let old_ref = raw.clone();
                            let secret = secret_store.read_secret(&old_ref)?.ok_or_else(|| {
                                ApiError::Internal(format!(
                                    "Missing keyring secret for reference '{old_ref}' at '{next_path}'"
                                ))
                            })?;
                            let new_ref = secret_store.store_secret(&next_path, &secret)?;
                            secret_store.delete_secret(&old_ref)?;
                            Some(new_ref)
                        }
                        Value::String(raw) => Some(secret_store.store_secret(&next_path, raw)?),
                        _ => {
                            let serialized = serde_json::to_string(val).map_err(ApiError::internal)?;
                            Some(secret_store.store_secret(&next_path, &serialized)?)
                        }
                    };

                    if let Some(new_ref) = replacement {
                        *val = Value::String(new_ref);
                        *rotated += 1;
                    }
                    continue;
                }

                rotate_walk(val, &next_path, secret_store, rotated)?;
            }
        }
        Value::Array(items) => {
            for (idx, item) in items.iter_mut().enumerate() {
                let next_path = if path.is_empty() {
                    idx.to_string()
                } else {
                    format!("{path}[{idx}]")
                };
                rotate_walk(item, &next_path, secret_store, rotated)?;
            }
        }
        _ => {}
    }

    Ok(())
}

fn join_path(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn build_reference(path: &str) -> String {
    let path_hash = hash_path(path);
    format!("{KEYRING_PREFIX}{path_hash}/{}", Uuid::new_v4())
}

fn hash_path(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)[..16].to_string()
}

fn reference_to_account(reference: &str) -> Result<String, ApiError> {
    if !is_keyring_reference(reference) {
        return Err(ApiError::BadRequest(format!(
            "Invalid keyring reference '{reference}'"
        )));
    }

    let suffix = reference.trim_start_matches(KEYRING_PREFIX);
    if suffix.trim().is_empty() {
        return Err(ApiError::BadRequest(format!(
            "Invalid keyring reference '{reference}'"
        )));
    }

    Ok(suffix.replace('/', ":"))
}

#[cfg(test)]
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn store_secret(&self, path: &str, secret: &str) -> Result<String, ApiError> {
        let reference = build_reference(path);
        if let Ok(mut guard) = self.values.lock() {
            guard.insert(reference.clone(), secret.to_string());
        }
        Ok(reference)
    }

    fn read_secret(&self, reference: &str) -> Result<Option<String>, ApiError> {
        if !is_keyring_reference(reference) {
            return Ok(Some(reference.to_string()));
        }

        if let Ok(guard) = self.values.lock() {
            return Ok(guard.get(reference).cloned());
        }

        Ok(None)
    }

    fn delete_secret(&self, reference: &str) -> Result<(), ApiError> {
        if !is_keyring_reference(reference) {
            return Ok(());
        }

        if let Ok(mut guard) = self.values.lock() {
            guard.remove(reference);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{is_keyring_reference, is_sensitive_key};

    #[test]
    fn sensitive_key_uses_whitelist() {
        assert!(is_sensitive_key("api_key"));
        assert!(!is_sensitive_key("max_tokens"));
    }

    #[test]
    fn keyring_prefix_detection_works() {
        assert!(is_keyring_reference("keyring://tepora/config/abc/def"));
        assert!(!is_keyring_reference("plain_secret"));
    }
}
