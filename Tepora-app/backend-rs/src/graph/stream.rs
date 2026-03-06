use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::SinkExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::actor::SessionEvent;
use crate::core::errors::ApiError;
use crate::core::security_controls::{
    ToolApprovalRequestPayload, ToolApprovalResponsePayload,
};

pub enum GraphStreamer<'a> {
    WebSocket(&'a mut SplitSink<WebSocket, Message>),
    Actor {
        session_id: String,
        tx: tokio::sync::broadcast::Sender<SessionEvent>,
    },
}

impl<'a> GraphStreamer<'a> {
    pub async fn send_json(&mut self, payload: Value) -> Result<(), ApiError> {
        match self {
            Self::WebSocket(ws) => {
                let text = serde_json::to_string(&payload).map_err(ApiError::internal)?;
                ws.send(Message::Text(text))
                    .await
                    .map_err(ApiError::internal)?;
            }
            Self::Actor { session_id, tx } => {
                let msg_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match msg_type {
                    "chunk" => {
                        let text = payload
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = tx.send(SessionEvent::Token {
                            session_id: session_id.clone(),
                            text,
                        });
                    }
                    "thought" => {
                        let content = payload
                            .get("content")
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = tx.send(SessionEvent::Thought {
                            session_id: session_id.clone(),
                            content,
                        });
                    }
                    "error" => {
                        let text = payload
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = tx.send(SessionEvent::Error {
                            session_id: session_id.clone(),
                            message: text,
                        });
                    }
                    "node_completed" => {
                        let node_id = payload
                            .get("nodeId")
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let output = payload
                            .get("output")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({}));
                        let _ = tx.send(SessionEvent::NodeCompleted {
                            session_id: session_id.clone(),
                            node_id,
                            output,
                        });
                    }
                    "done" | "stopped" => {
                        let _ = tx.send(SessionEvent::GenerationComplete {
                            session_id: session_id.clone(),
                        });
                    }
                    _ => {
                        let _ = tx.send(SessionEvent::Status {
                            session_id: session_id.clone(),
                            message: serde_json::to_string(&payload).unwrap_or_default(),
                        });
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn send_activity(
        &mut self,
        id: &str,
        status: &str,
        message: &str,
        agent_name: &str,
    ) -> Result<(), ApiError> {
        self.send_json(json!({
            "type": "activity",
            "data": {
                "id": id,
                "status": status,
                "message": message,
                "agentName": agent_name,
            }
        }))
        .await
    }

    pub async fn request_tool_approval(
        &mut self,
        pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ToolApprovalResponsePayload>>>>,
        mut request: ToolApprovalRequestPayload,
        timeout_secs: u64,
    ) -> Result<ToolApprovalResponsePayload, ApiError> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        request.request_id = request_id.clone();

        {
            let mut map = pending.lock().map_err(ApiError::internal)?;
            map.insert(request_id, tx);
        }

        self.send_json(json!({
            "type": "tool_confirmation_request",
            "data": request,
        }))
        .await?;

        let approval = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx)
            .await
            .unwrap_or(Ok(ToolApprovalResponsePayload::denied()))
            .unwrap_or_else(|_| ToolApprovalResponsePayload::denied());

        Ok(approval)
    }
}
