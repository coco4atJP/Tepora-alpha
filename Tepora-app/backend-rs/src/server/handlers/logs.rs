use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use std::fs;

use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::state::AppStateRead;

pub async fn get_logs(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let mut logs = Vec::new();
    let log_dir = &state.paths.log_dir;
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
    Ok(Json(json!(log_names)))
}

pub async fn get_log_content(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
    Path(filename): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let log_dir = &state.paths.log_dir;

    // C-2 fix: ファイル名のみ許可（パス区切り / ".." / 絶対パスを拒否）
    let safe_name = sanitize_log_filename(&filename)
        .ok_or_else(|| ApiError::BadRequest("Invalid log filename".to_string()))?;
    let path = log_dir.join(safe_name);

    if !path.exists() {
        return Err(ApiError::NotFound("Log file not found".to_string()));
    }

    let content = fs::read_to_string(path).map_err(ApiError::internal)?;
    Ok(content)
}

/// ログファイル名をサニタイズする。ベース名のみ許可し、トラバーサルを拒否。
fn sanitize_log_filename(filename: &str) -> Option<&str> {
    let base = std::path::Path::new(filename)
        .file_name()
        .and_then(|n| n.to_str())?;
    if base == filename && !filename.contains("..") {
        Some(base)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_accepts_normal_log_filename() {
        assert_eq!(sanitize_log_filename("app.log"), Some("app.log"));
        assert_eq!(
            sanitize_log_filename("debug-2026.log"),
            Some("debug-2026.log")
        );
    }

    #[test]
    fn sanitize_rejects_parent_traversal() {
        assert_eq!(sanitize_log_filename("../secret.txt"), None);
        assert_eq!(sanitize_log_filename("..\\secret.txt"), None);
        assert_eq!(sanitize_log_filename("foo/../bar.log"), None);
    }

    #[test]
    fn sanitize_rejects_absolute_path() {
        assert_eq!(sanitize_log_filename("/etc/passwd"), None);
        assert_eq!(
            sanitize_log_filename("C:\\Windows\\System32\\foo.log"),
            None
        );
    }

    #[test]
    fn sanitize_rejects_directory_prefix() {
        assert_eq!(sanitize_log_filename("subdir/app.log"), None);
        assert_eq!(sanitize_log_filename("subdir\\app.log"), None);
    }
}
