use std::env;
use std::fs;
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;

use axum::http::HeaderMap;
use uuid::Uuid;

use crate::errors::ApiError;

const API_KEY_HEADER: &str = "x-api-key";

#[derive(Debug, Clone)]
pub struct SessionToken {
    value: String,
}

impl SessionToken {
    pub fn value(&self) -> &str {
        &self.value
    }
}

pub fn init_session_token() -> SessionToken {
    if let Ok(token) = env::var("TEPORA_SESSION_TOKEN") {
        if !token.trim().is_empty() {
            return SessionToken { value: token };
        }
    }

    let token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
    let token_path = session_token_path();
    if let Some(parent) = token_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(err) = fs::write(&token_path, &token) {
        tracing::warn!("Failed to write session token: {}", err);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(&token_path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(&token_path, perms);
        }
    }
    #[cfg(windows)]
    {
        apply_windows_token_acl(&token_path);
    }

    SessionToken { value: token }
}

fn session_token_path() -> PathBuf {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".tepora").join(".session_token")
}

#[cfg(windows)]
fn apply_windows_token_acl(path: &std::path::Path) {
    let Some(path_str) = path.to_str() else {
        return;
    };

    let username = match env::var("USERNAME") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return,
    };
    let grant = format!("{}:(F)", username);

    let mut command = Command::new("icacls");
    command
        .arg(path_str)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(&grant)
        .arg("/remove:g")
        .arg("Users")
        .arg("Authenticated Users")
        .arg("Everyone");

    match command.status() {
        Ok(status) if status.success() => {}
        Ok(status) => {
            tracing::warn!(
                "Failed to apply Windows ACL to session token (status: {})",
                status
            )
        }
        Err(err) => tracing::warn!("Failed to run icacls for session token ACL: {}", err),
    }
}

pub fn require_api_key(headers: &HeaderMap, expected: &SessionToken) -> Result<(), ApiError> {
    let header_value = headers
        .get(API_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if header_value.is_empty() {
        return Err(ApiError::Unauthorized);
    }

    if header_value != expected.value() {
        return Err(ApiError::Unauthorized);
    }

    Ok(())
}

#[allow(dead_code)]
pub fn api_key_optional(headers: &HeaderMap, expected: &SessionToken) -> Option<String> {
    headers
        .get(API_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| *value == expected.value())
        .map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn require_api_key_accepts_valid_header() {
        let expected = SessionToken {
            value: "secret".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(API_KEY_HEADER, HeaderValue::from_static("secret"));

        let result = require_api_key(&headers, &expected);

        assert!(result.is_ok());
    }

    #[test]
    fn require_api_key_rejects_missing_or_invalid_header() {
        let expected = SessionToken {
            value: "secret".to_string(),
        };
        let headers = HeaderMap::new();

        let missing = require_api_key(&headers, &expected);
        assert!(matches!(missing, Err(ApiError::Unauthorized)));

        let mut invalid_headers = HeaderMap::new();
        invalid_headers.insert(API_KEY_HEADER, HeaderValue::from_static("wrong"));
        let invalid = require_api_key(&invalid_headers, &expected);
        assert!(matches!(invalid, Err(ApiError::Unauthorized)));
    }

    #[test]
    fn api_key_optional_only_returns_on_match() {
        let expected = SessionToken {
            value: "secret".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(API_KEY_HEADER, HeaderValue::from_static("secret"));

        let matched = api_key_optional(&headers, &expected);
        assert_eq!(matched.as_deref(), Some("secret"));

        let mut wrong_headers = HeaderMap::new();
        wrong_headers.insert(API_KEY_HEADER, HeaderValue::from_static("nope"));
        let mismatched = api_key_optional(&wrong_headers, &expected);
        assert_eq!(mismatched, None);
    }

    #[test]
    fn require_api_key_rejects_non_utf8_header_value() {
        let expected = SessionToken {
            value: "secret".to_string(),
        };
        let mut headers = HeaderMap::new();
        let non_utf8 = HeaderValue::from_bytes(&[0xFF, 0xFE, 0xFD])
            .expect("header value bytes should be accepted");
        headers.insert(API_KEY_HEADER, non_utf8);

        let result = require_api_key(&headers, &expected);

        assert!(matches!(result, Err(ApiError::Unauthorized)));
    }

    #[test]
    fn api_key_optional_returns_none_for_non_utf8_header() {
        let expected = SessionToken {
            value: "secret".to_string(),
        };
        let mut headers = HeaderMap::new();
        let non_utf8 = HeaderValue::from_bytes(&[0xFF, 0xFE, 0xFD])
            .expect("header value bytes should be accepted");
        headers.insert(API_KEY_HEADER, non_utf8);

        let result = api_key_optional(&headers, &expected);

        assert_eq!(result, None);
    }
}
