use serde_json::Value;
use tokio::sync::oneshot;

use crate::core::security_controls::ToolApprovalResponsePayload;

#[derive(Debug)]
pub enum SessionQuery {
    GetStatus {
        session_id: String,
        reply_to: oneshot::Sender<String>,
    },
}

#[derive(Debug, Clone)]
pub enum SessionCommand {
    ProcessMessage {
        session_id: String,
        message: String,
        mode: String,
        attachments: Vec<Value>,
        thinking_budget: u8,
        agent_id: Option<String>,
        agent_mode: Option<String>,
        skip_web_search: bool,
    },
    StopGeneration { session_id: String },
    ToolApprovalResponse {
        session_id: String,
        request_id: String,
        approval: ToolApprovalResponsePayload,
    },
    Shutdown { session_id: String },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    Token { session_id: String, text: String },
    Thought { session_id: String, content: String },
    Status { session_id: String, message: String },
    Error { session_id: String, message: String },
    NodeCompleted {
        session_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
        output: Value,
    },
    MemoryGeneration {
        session_id: String,
        status: String,
    },
    GenerationComplete { session_id: String },
}
