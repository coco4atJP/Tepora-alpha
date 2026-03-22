use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::core::errors::ApiError;

const EXPIRING_SOON_DAYS: i64 = 7;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialStatus {
    pub provider: String,
    pub status: String,
    pub present: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub last_rotated_at: Option<String>,
}

pub fn credential_statuses(config: &Value) -> Vec<CredentialStatus> {
    let providers = [
        ("google_search", "google_search_api_key"),
        ("brave_search", "brave_search_api_key"),
        ("bing_search", "bing_search_api_key"),
    ];
    let mut statuses = Vec::new();
    for (provider, field) in providers {
        let present = config
            .get("tools")
            .and_then(|value| value.get(field))
            .and_then(|value| value.as_str())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        let metadata = config
            .get("credentials")
            .and_then(|value| value.get(provider));
        let expires_at = metadata
            .and_then(|value| value.get("expires_at"))
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let last_rotated_at = metadata
            .and_then(|value| value.get("last_rotated_at"))
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let status = match (present, expires_at.as_deref()) {
            (false, _) => "missing".to_string(),
            (true, Some(expires_at)) => match chrono::DateTime::parse_from_rfc3339(expires_at)
                .map(|value| value.with_timezone(&Utc))
                .ok()
            {
                Some(expiry) if expiry <= Utc::now() => "expired".to_string(),
                Some(expiry) if expiry <= Utc::now() + Duration::days(EXPIRING_SOON_DAYS) => {
                    "expiring_soon".to_string()
                }
                _ => metadata
                    .and_then(|value| value.get("status"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("active")
                    .to_string(),
            },
            (true, None) => metadata
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str())
                .unwrap_or("active")
                .to_string(),
        };
        statuses.push(CredentialStatus {
            provider: provider.to_string(),
            status,
            present,
            expires_at,
            last_rotated_at,
        });
    }
    statuses
}

pub fn rotate_credential(
    config: &mut Value,
    provider: &str,
    secret: &str,
    expires_at: Option<&str>,
    rotated_at: &str,
) -> Result<(), ApiError> {
    let secret_field = match provider {
        "google_search" => "google_search_api_key",
        "brave_search" => "brave_search_api_key",
        "bing_search" => "bing_search_api_key",
        _ => {
            return Err(ApiError::BadRequest(format!(
                "Unknown credential provider '{}'",
                provider
            )));
        }
    };
    let root = config
        .as_object_mut()
        .ok_or_else(|| ApiError::BadRequest("Invalid config root".to_string()))?;
    let tools = ensure_object(root, "tools");
    tools.insert(secret_field.to_string(), Value::String(secret.to_string()));
    let credentials = ensure_object(root, "credentials");
    let metadata = ensure_object(credentials, provider);
    metadata.insert("status".to_string(), Value::String("active".to_string()));
    metadata.insert(
        "last_rotated_at".to_string(),
        Value::String(rotated_at.to_string()),
    );
    match expires_at {
        Some(value) if !value.trim().is_empty() => {
            metadata.insert("expires_at".to_string(), Value::String(value.to_string()));
        }
        _ => {
            metadata.remove("expires_at");
        }
    }
    Ok(())
}

fn ensure_object<'a>(root: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    root.entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("object inserted")
}
