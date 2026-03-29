use std::env;
use std::fs;
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;

use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use rand::Rng;
use subtle::ConstantTimeEq;

use crate::core::errors::ApiError;

const API_KEY_HEADER: &str = "x-api-key";

/// セッショントークンのデフォルト有効期間（日数）
///
/// ローカルファーストアプリとして、7日間を標準TTLとする。
/// `TEPORA_TOKEN_TTL_DAYS` 環境変数で上書き可能。
const DEFAULT_TOKEN_TTL_DAYS: u64 = 7;

#[derive(Debug, Clone)]
pub struct SessionToken {
    value: String,
    /// トークン発行時刻（有効期限チェック用）
    created_at: DateTime<Utc>,
    /// トークンの有効期限
    expires_at: DateTime<Utc>,
}

impl SessionToken {
    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }

    /// トークンの有効期限を返す。
    pub fn expires_at(&self) -> &DateTime<Utc> {
        &self.expires_at
    }

    /// トークンの経過時間（秒）を返す。
    #[allow(dead_code)]
    pub fn age_seconds(&self) -> i64 {
        Utc::now()
            .signed_duration_since(self.created_at)
            .num_seconds()
    }

    /// トークンの発行時刻を返す。
    #[allow(dead_code)]
    pub fn created_at(&self) -> &DateTime<Utc> {
        &self.created_at
    }

    pub fn reissue(&mut self) -> Result<String, ApiError> {
        let token_bytes: [u8; 32] = rand::thread_rng().gen();
        let new_token = hex::encode(token_bytes);
        self.value = new_token.clone();

        let now = Utc::now();
        let ttl_days = env::var("TEPORA_TOKEN_TTL_DAYS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_TOKEN_TTL_DAYS);

        self.created_at = now;
        self.expires_at = now + chrono::Duration::days(ttl_days as i64);

        let token_path = session_token_path();
        if let Some(parent) = token_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&token_path, &new_token).map_err(ApiError::internal)?;

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

        Ok(new_token)
    }
}

pub fn init_session_token() -> SessionToken {
    let now = Utc::now();
    let ttl_days = env::var("TEPORA_TOKEN_TTL_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TOKEN_TTL_DAYS);
    let expires_at = now + chrono::Duration::days(ttl_days as i64);

    if let Ok(token) = env::var("TEPORA_SESSION_TOKEN") {
        if !token.trim().is_empty() {
            return SessionToken {
                value: token,
                created_at: now,
                expires_at,
            };
        }
    }

    let token_bytes: [u8; 32] = rand::thread_rng().gen();
    let token = hex::encode(token_bytes);
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

    SessionToken {
        value: token,
        created_at: now,
        expires_at,
    }
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

pub fn require_api_key(
    headers: &HeaderMap,
    expected: &SessionToken,
    allow_expired: bool,
) -> Result<(), ApiError> {
    let header_value = headers
        .get(API_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if header_value.is_empty() {
        return Err(ApiError::Unauthorized);
    }

    let input = header_value.as_bytes();
    let expected_bytes = expected.value().as_bytes();
    if input.len() != expected_bytes.len() || input.ct_ne(expected_bytes).into() {
        return Err(ApiError::Unauthorized);
    }

    // トークンが期限切れの場合は警告を出して拒否する（allow_expiredがtrueなら許可）
    if !allow_expired && expected.is_expired() {
        tracing::warn!(
            "Session token has expired (age: {} seconds). Please restart the application to rotate the token.",
            expected.age_seconds()
        );
        return Err(ApiError::TokenExpired);
    }

    Ok(())
}

#[allow(dead_code)]
pub fn api_key_optional(headers: &HeaderMap, expected: &SessionToken) -> Option<String> {
    headers
        .get(API_KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            let input = value.as_bytes();
            let expected_bytes = expected.value().as_bytes();
            input.len() == expected_bytes.len()
                && bool::from(input.ct_eq(expected_bytes))
        })
        .map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use chrono::Duration;

    fn make_token(value: &'static str) -> SessionToken {
        let now = Utc::now();
        SessionToken {
            value: value.to_string(),
            created_at: now,
            expires_at: now + Duration::days(DEFAULT_TOKEN_TTL_DAYS as i64),
        }
    }

    fn make_expired_token(value: &'static str) -> SessionToken {
        let now = Utc::now();
        let created_at = now - Duration::days(8);
        SessionToken {
            value: value.to_string(),
            created_at,
            expires_at: created_at + Duration::days(DEFAULT_TOKEN_TTL_DAYS as i64),
        }
    }

    #[test]
    fn require_api_key_accepts_valid_header() {
        let expected = make_token("test-secret-token");
        let mut headers = HeaderMap::new();
        headers.insert(
            API_KEY_HEADER,
            HeaderValue::from_static("test-secret-token"),
        );

        let result = require_api_key(&headers, &expected, false);

        assert!(result.is_ok());
    }

    #[test]
    fn require_api_key_rejects_missing_or_invalid_header() {
        let expected = make_token("test-secret-token");
        let headers = HeaderMap::new();

        let missing = require_api_key(&headers, &expected, false);
        assert!(matches!(missing, Err(ApiError::Unauthorized)));

        let mut invalid_headers = HeaderMap::new();
        invalid_headers.insert(API_KEY_HEADER, HeaderValue::from_static("wrong"));
        let invalid = require_api_key(&invalid_headers, &expected, false);
        assert!(matches!(invalid, Err(ApiError::Unauthorized)));
    }

    #[test]
    fn require_api_key_rejects_expired_token() {
        let expected = make_expired_token("test-secret-token");
        let mut headers = HeaderMap::new();
        headers.insert(
            API_KEY_HEADER,
            HeaderValue::from_static("test-secret-token"),
        );

        // 値は正しいが有効期限切れ → TokenExpired
        let result = require_api_key(&headers, &expected, false);
        assert!(
            matches!(result, Err(ApiError::TokenExpired)),
            "Expired token should be rejected with TokenExpired"
        );
    }

    #[test]
    fn session_token_is_not_expired_when_fresh() {
        let token = make_token("fresh-token");
        assert!(!token.is_expired(), "Fresh token should not be expired");
    }

    #[test]
    fn session_token_is_expired_after_ttl() {
        let token = make_expired_token("old-token");
        assert!(token.is_expired(), "Token older than TTL should be expired");
    }

    #[test]
    fn api_key_optional_only_returns_on_match() {
        let expected = make_token("test-secret-token");
        let mut headers = HeaderMap::new();
        headers.insert(
            API_KEY_HEADER,
            HeaderValue::from_static("test-secret-token"),
        );

        let matched = api_key_optional(&headers, &expected);
        assert_eq!(matched.as_deref(), Some("test-secret-token"));

        let mut wrong_headers = HeaderMap::new();
        wrong_headers.insert(API_KEY_HEADER, HeaderValue::from_static("nope"));
        let mismatched = api_key_optional(&wrong_headers, &expected);
        assert_eq!(mismatched, None);
    }

    #[test]
    fn require_api_key_rejects_non_utf8_header_value() {
        let expected = make_token("test-secret-token");
        let mut headers = HeaderMap::new();
        let non_utf8 = HeaderValue::from_bytes(&[0xFF, 0xFE, 0xFD])
            .expect("header value bytes should be accepted");
        headers.insert(API_KEY_HEADER, non_utf8);

        let result = require_api_key(&headers, &expected, false);

        assert!(matches!(result, Err(ApiError::Unauthorized)));
    }

    #[test]
    fn api_key_optional_returns_none_for_non_utf8_header() {
        let expected = make_token("test-secret-token");
        let mut headers = HeaderMap::new();
        let non_utf8 = HeaderValue::from_bytes(&[0xFF, 0xFE, 0xFD])
            .expect("header value bytes should be accepted");
        headers.insert(API_KEY_HEADER, non_utf8);

        let result = api_key_optional(&headers, &expected);

        assert_eq!(result, None);
    }
}
