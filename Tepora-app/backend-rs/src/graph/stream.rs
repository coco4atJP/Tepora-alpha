use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::SinkExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::actor::SessionEvent;
use crate::core::errors::ApiError;

/// Abstraction for streaming graph events to either a WebSocket or an internal Actor bus.
pub enum GraphStreamer<'a> {
    WebSocket(&'a mut SplitSink<WebSocket, Message>),
    Actor {
        session_id: String,
        tx: tokio::sync::broadcast::Sender<SessionEvent>,
    },
}

impl<'a> GraphStreamer<'a> {
    /// Sends a raw JSON payload
    pub async fn send_json(&mut self, payload: Value) -> Result<(), ApiError> {
        match self {
            Self::WebSocket(ws) => {
                let text = serde_json::to_string(&payload).map_err(ApiError::internal)?;
                ws.send(Message::Text(text)).await.map_err(ApiError::internal)?;
            }
            Self::Actor { session_id, tx } => {
                let msg_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match msg_type {
                    "chunk" => {
                        let text = payload.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
                        let _ = tx.send(SessionEvent::Token { session_id: session_id.clone(), text });
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
                        let text = payload.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
                        let _ = tx.send(SessionEvent::Error { session_id: session_id.clone(), message: text });
                    }
                    "node_completed" => {
                        let node_id = payload.get("nodeId").and_then(|n| n.as_str()).unwrap_or("unknown").to_string();
                        let output = payload.get("output").cloned().unwrap_or_else(|| serde_json::json!({}));
                        let _ = tx.send(SessionEvent::NodeCompleted {
                            session_id: session_id.clone(),
                            node_id,
                            output,
                        });
                    }
                    "done" | "stopped" => {
                        let _ = tx.send(SessionEvent::GenerationComplete { session_id: session_id.clone() });
                    }
                    _ => {
                        let _ = tx.send(SessionEvent::Status { 
                            session_id: session_id.clone(),
                            message: serde_json::to_string(&payload).unwrap_or_default() 
                        });
                    }
                }
            }
        }
        Ok(())
    }

    /// Sends an activity status update
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
        })).await
    }

    /// Requests user approval for a tool execution
    pub async fn request_tool_approval(
        &mut self,
        pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
        tool_name: &str,
        tool_args: &Value,
        timeout_secs: u64,
    ) -> Result<bool, ApiError> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();

        {
            let mut map = pending.lock().map_err(ApiError::internal)?;
            map.insert(request_id.clone(), tx);
        }

        let payload = json!({
            "type": "tool_confirmation_request",
            "data": {
                "requestId": request_id,
                "toolName": tool_name,
                "toolArgs": if tool_args.is_object() { tool_args.clone() } else { json!({ "input": tool_args }) },
                "description": format!("Tool '{}' requires your approval to execute.", tool_name),
            }
        });
        
        self.send_json(payload).await?;

        // In actor mode, tool approval flow may need specific event plumbing.
        // For now, it will wait for the same `pending` map completion.

        let approval = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx)
            .await
            .unwrap_or(Ok(false))
            .unwrap_or(false);

        if let Ok(mut map) = pending.lock() {
            map.remove(&request_id);
        }

        Ok(approval)
    }
}
