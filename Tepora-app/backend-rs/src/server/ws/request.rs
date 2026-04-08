use std::time::Duration;

use serde_json::{json, Value};

use crate::core::errors::ApiError;
use crate::core::security_controls::detect_pii_in_attachments;
use crate::state::AppState;

use super::protocol::WsIncomingMessage;

pub struct GenerationRequest {
    pub session_id: String,
    pub message_text: String,
    pub attachments: Vec<Value>,
    pub mode: String,
    pub thinking_budget: u8,
    pub search_mode: Option<String>,
    pub requested_agent_id: Option<String>,
    pub requested_agent_mode: Option<String>,
    pub skip_search: bool,
    pub timestamp: String,
    pub user_kwargs: Value,
    pub timeout_override: Option<Duration>,
}

pub fn build_generation_request(
    state: &AppState,
    current_session_id: &str,
    data: WsIncomingMessage,
) -> Result<GenerationRequest, ApiError> {
    let message_text = data.message.unwrap_or_default();
    let attachments = data.attachments;

    if state.core().security.is_lockdown_enabled() {
        return Err(ApiError::Conflict(
            "Privacy Lockdown is enabled; new chat requests are blocked".to_string(),
        ));
    }

    let pii_findings = detect_pii_in_attachments(&attachments);
    if !pii_findings.is_empty() {
        let categories = pii_findings
            .iter()
            .map(|finding| finding.category.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(", ");
        state.core().security.record_audit(
            "attachment_pii_warning",
            "blocked",
            json!({ "categories": categories }),
        )?;
        return Err(ApiError::Conflict(format!(
            "Attachment contains potential PII and requires confirmation: {}",
            categories
        )));
    }

    // 画像添付のサイズバリデーション（バックエンド上限: 10MB per image）
    // フロントエンドの5MB圧縮を通過してきた後の二重チェック
    const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024; // 10MB
    for att in &attachments {
        let mime = att.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if mime.starts_with("image/") {
            let b64 = att.get("content").and_then(|v| v.as_str()).unwrap_or("");
            // Base64 → バイトサイズの近似値 (実際のバイト数 ≈ b64_len * 3/4)
            let approx_bytes = b64.len() * 3 / 4;
            if approx_bytes > IMAGE_MAX_BYTES {
                let name = att.get("name").and_then(|v| v.as_str()).unwrap_or("image");
                return Err(ApiError::BadRequest(format!(
                    "Image attachment '{}' exceeds 10MB limit (approx {} MB). Please compress the image before uploading.",
                    name,
                    approx_bytes / (1024 * 1024)
                )));
            }
        }
    }

    let session_id = data
        .session_id
        .unwrap_or_else(|| current_session_id.to_string());
    let mode = data.mode.unwrap_or_else(|| "chat".to_string());
    let thinking_budget = std::cmp::min(data.thinking_budget.unwrap_or(0), 3);
    let search_mode = data.search_mode;
    let requested_agent_id = data.agent_id;
    let requested_agent_mode = data.agent_mode;
    let skip_search = data.skip_web_search.unwrap_or(false);
    let timestamp = chrono::Utc::now().to_rfc3339();
    let timeout_override = data.timeout.map(Duration::from_millis);

    validate_message_text(state, &message_text)?;

    let user_kwargs = json!({
        "timestamp": timestamp.clone(),
        "mode": mode.clone(),
        "attachments": attachments.clone(),
        "thinking_budget": thinking_budget,
        "search_mode": search_mode.clone(),
        "agent_id": requested_agent_id.clone(),
        "agent_mode": requested_agent_mode.clone(),
        "skip_web_search": Some(skip_search),
    });

    Ok(GenerationRequest {
        session_id,
        message_text,
        attachments,
        mode,
        thinking_budget,
        search_mode,
        requested_agent_id,
        requested_agent_mode,
        skip_search,
        timestamp,
        user_kwargs,
        timeout_override,
    })
}

fn validate_message_text(state: &AppState, message_text: &str) -> Result<(), ApiError> {
    let config = state.core().config.load_config()?;

    let max_input_length = config
        .get("app")
        .and_then(|app| app.get("max_input_length"))
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(4096);

    if message_text.len() > max_input_length {
        return Err(ApiError::BadRequest(format!(
            "Message length {} exceeds maximum allowed {}",
            message_text.len(),
            max_input_length
        )));
    }

    let dangerous_patterns = config
        .get("app")
        .and_then(|app| app.get("dangerous_patterns"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    for pattern in dangerous_patterns {
        if let Ok(re) = regex::Regex::new(&pattern) {
            if re.is_match(message_text) {
                return Err(ApiError::BadRequest(
                    "Message contains restricted content".to_string(),
                ));
            }
        }
    }

    Ok(())
}
