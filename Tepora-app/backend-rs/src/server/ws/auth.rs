use axum::http::HeaderMap;
use serde_json::Value;

use crate::state::AppState;

use super::protocol::WS_TOKEN_PREFIX;

pub fn validate_origin(headers: &HeaderMap, state: &AppState) -> bool {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    if let Some(o) = origin {
        tracing::debug!("Checking Origin: {}", o);
    } else {
        tracing::debug!("No Origin header found");
    }

    if origin.is_none() {
        let env = std::env::var("TEPORA_ENV").unwrap_or_else(|_| "production".to_string());
        return env != "production";
    }

    let allowed = state
        .core()
        .config
        .load_config()
        .ok()
        .and_then(|cfg| {
            cfg.get("server")
                .and_then(|server| server.as_object())
                .and_then(|server| {
                    server
                        .get("ws_allowed_origins")
                        .or_else(|| server.get("cors_allowed_origins"))
                        .or_else(|| server.get("allowed_origins"))
                        .cloned()
                })
        })
        .and_then(|list| list.as_array().cloned())
        .unwrap_or_else(|| {
            vec![
                Value::String("tauri://localhost".to_string()),
                Value::String("https://tauri.localhost".to_string()),
                Value::String("http://tauri.localhost".to_string()),
                Value::String("http://localhost".to_string()),
                Value::String("http://localhost:5173".to_string()),
                Value::String("http://localhost:3000".to_string()),
                Value::String("http://127.0.0.1:5173".to_string()),
                Value::String("http://127.0.0.1:3000".to_string()),
                Value::String("http://127.0.0.1:8000".to_string()),
                Value::String("http://127.0.0.1".to_string()),
            ]
        });

    let origin = origin.unwrap_or("");
    for entry in allowed {
        if let Some(allowed_origin) = entry.as_str() {
            if origin == allowed_origin || origin.starts_with(&format!("{}/", allowed_origin)) {
                return true;
            }
        }
    }

    if origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:") {
        return true;
    }

    tracing::warn!("Origin blocked: {}", origin);
    false
}

pub async fn validate_token(headers: &HeaderMap, state: &AppState) -> bool {
    let token = state.core().session_token.read().await;
    extract_token_from_protocol_header(headers)
        .map(|extracted| extracted == token.value())
        .unwrap_or(false)
}

fn extract_token_from_protocol_header(headers: &HeaderMap) -> Option<String> {
    let protocol_header = headers.get("sec-websocket-protocol")?.to_str().ok()?;
    for item in protocol_header.split(',') {
        let protocol = item.trim();
        let Some(encoded) = protocol.strip_prefix(WS_TOKEN_PREFIX) else {
            continue;
        };
        if encoded.is_empty() {
            return None;
        }
        let bytes = hex::decode(encoded).ok()?;
        let token = String::from_utf8(bytes).ok()?;
        if !token.is_empty() {
            return Some(token);
        }
    }
    None
}
