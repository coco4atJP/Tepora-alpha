use serde::Deserialize;
use serde_json::Value;

use crate::core::security_controls::ToolApprovalResponsePayload;

pub const WS_APP_PROTOCOL: &str = "tepora.v1";
pub const WS_TOKEN_PREFIX: &str = "tepora-token.";

#[derive(Debug, Deserialize, Default, Clone)]
pub struct WsIncomingMessage {
    #[serde(rename = "type")]
    pub msg_type: Option<String>,
    pub message: Option<String>,
    pub mode: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(rename = "skipWebSearch")]
    pub skip_web_search: Option<bool>,
    #[serde(rename = "thinkingBudget")]
    pub thinking_budget: Option<u8>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    #[serde(rename = "agentMode")]
    pub agent_mode: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "requestId")]
    pub request_id: Option<String>,
    pub approved: Option<bool>,
    #[serde(flatten)]
    pub approval: ToolApprovalResponsePayload,
    pub timeout: Option<u64>,
}
