use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::sync::OnceLock;

#[derive(Deserialize)]
pub struct FrontendLogPayload {
    pub level: String,
    pub message: String,
}

use crate::core::errors::ApiError;
use crate::infrastructure::transport::log_forwarder;
use crate::state::AppStateRead;

pub async fn get_logs(State(state): State<AppStateRead>) -> Result<impl IntoResponse, ApiError> {
    let mut logs = Vec::new();
    let log_dir = &state.core().paths.log_dir;
    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("log") {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    logs.push((
                        name.to_string(),
                        entry.metadata().and_then(|m| m.modified()).ok(),
                    ));
                }
            }
        }
    }

    logs.sort_by(|a, b| b.1.cmp(&a.1));

    let log_names: Vec<String> = logs.into_iter().map(|(name, _)| name).collect();
    Ok(Json(json!({ "logs": log_names })))
}

pub async fn receive_frontend_logs(
    State(state): State<AppStateRead>,
    Json(payload): Json<FrontendLogPayload>,
) -> Result<impl IntoResponse, ApiError> {
    if !state.is_redesign_enabled("frontend_logging") {
        return Ok(Json(json!({ "status": "ignored" })));
    }
    if state.core().security.is_lockdown_enabled() {
        state.core().security.record_audit(
            "frontend_log_forward",
            "blocked",
            json!({ "level": payload.level }),
        )?;
        return Ok(Json(json!({ "status": "ignored", "reason": "lockdown" })));
    }

    let level = payload.level.to_ascii_lowercase();
    if level != "error" && level != "warn" {
        tracing::debug!(
            target: "frontend",
            level = %payload.level,
            "Ignored frontend log due to allowlist"
        );
        return Ok(Json(
            json!({ "status": "ignored", "reason": "level_not_allowed" }),
        ));
    }

    let sanitized = sanitize_frontend_message(&payload.message);

    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{}", sanitized),
        "warn" => tracing::warn!(target: "frontend", "{}", sanitized),
        _ => {}
    }

    if let Err(err) =
        log_forwarder::append_frontend_log(&state.core().paths.log_dir, &level, &sanitized)
    {
        tracing::warn!(
            target: "frontend",
            error = %err,
            "Failed to persist frontend log entry"
        );
    } else {
        state.core().security.record_audit(
            "frontend_log_forward",
            "ok",
            json!({ "level": level }),
        )?;
    }

    Ok(Json(json!({ "status": "ok" })))
}

pub async fn get_log_content(
    State(state): State<AppStateRead>,
    Path(filename): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let log_dir = &state.core().paths.log_dir;
    let safe_name = sanitize_log_filename(&filename)
        .ok_or_else(|| ApiError::BadRequest("Invalid log filename".to_string()))?;
    let path = log_dir.join(safe_name);

    if !path.exists() {
        return Err(ApiError::NotFound("Log file not found".to_string()));
    }

    let content = fs::read_to_string(path).map_err(ApiError::internal)?;
    Ok(Json(json!({ "content": content })))
}

fn sanitize_log_filename(filename: &str) -> Option<&str> {
    if filename.is_empty()
        || filename.contains("..")
        || filename.contains('/')
        || filename.contains('\\')
        || has_windows_drive_prefix(filename)
        || filename.starts_with("//")
        || filename.starts_with("\\\\")
    {
        return None;
    }

    Some(filename)
}

fn has_windows_drive_prefix(filename: &str) -> bool {
    let bytes = filename.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn sanitize_frontend_message(message: &str) -> String {
    let capped = if message.chars().count() > 4000 {
        let truncated: String = message.chars().take(4000).collect();
        format!("{truncated}...[TRUNCATED]")
    } else {
        message.to_string()
    };

    let redacted_keys = api_key_regex().replace_all(&capped, "[REDACTED_KEY]");
    let redacted_prompt = prompt_regex()
        .replace_all(&redacted_keys, |caps: &Captures| {
            format!("{}[REDACTED_PROMPT]", &caps[1])
        })
        .into_owned();
    let redacted_windows_path = windows_user_dir_regex()
        .replace_all(&redacted_prompt, "[USER_DIR]")
        .into_owned();
    unix_user_dir_regex()
        .replace_all(&redacted_windows_path, "[USER_DIR]")
        .into_owned()
}

fn api_key_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"sk-[a-zA-Z0-9]{20,}").expect("valid API key regex"))
}

fn prompt_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)\b((?:user_)?prompt\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\n\r}]+)"#)
            .expect("valid prompt regex")
    })
}

fn windows_user_dir_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)[a-z]:\\users\\[^\\/\s]+").expect("valid windows user-dir regex")
    })
}

fn unix_user_dir_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/(?:home|Users)/[^/\s]+").expect("valid unix user-dir regex"))
}
