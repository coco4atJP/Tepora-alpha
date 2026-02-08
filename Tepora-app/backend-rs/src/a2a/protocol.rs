//! A2A Protocol message definitions.
//!
//! Based on the Agent-to-Agent communication protocol for
//! coordinating between specialized agents.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Types of A2A messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    /// Request to perform a task
    Request,
    /// Response to a request
    Response,
    /// Notification (no response expected)
    Notification,
    /// Error message
    Error,
    /// Acknowledgment
    Ack,
    /// Heartbeat/ping
    Ping,
    /// Heartbeat response
    Pong,
}

/// An A2A protocol message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2AMessage {
    /// Unique message identifier
    pub id: String,
    /// Message type
    #[serde(rename = "type")]
    pub message_type: MessageType,
    /// Sender agent identifier
    pub sender: String,
    /// Receiver agent identifier
    pub receiver: String,
    /// Message content (arbitrary JSON)
    pub content: serde_json::Value,
    /// Unix timestamp (seconds since epoch)
    pub timestamp: f64,
    /// Optional reference to a previous message (for responses)
    pub reply_to: Option<String>,
    /// Optional metadata
    pub metadata: Option<serde_json::Value>,
}

impl A2AMessage {
    /// Create a new A2A message.
    pub fn new(
        message_type: MessageType,
        sender: impl Into<String>,
        receiver: impl Into<String>,
        content: serde_json::Value,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            message_type,
            sender: sender.into(),
            receiver: receiver.into(),
            content,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0),
            reply_to: None,
            metadata: None,
        }
    }

    /// Create a request message.
    pub fn request(
        sender: impl Into<String>,
        receiver: impl Into<String>,
        content: serde_json::Value,
    ) -> Self {
        Self::new(MessageType::Request, sender, receiver, content)
    }

    /// Create a response message.
    pub fn response(
        original: &A2AMessage,
        sender: impl Into<String>,
        content: serde_json::Value,
    ) -> Self {
        let mut msg = Self::new(MessageType::Response, sender, original.sender.clone(), content);
        msg.reply_to = Some(original.id.clone());
        msg
    }

    /// Create an error response.
    pub fn error(
        original: &A2AMessage,
        sender: impl Into<String>,
        error_message: &str,
    ) -> Self {
        let mut msg = Self::new(
            MessageType::Error,
            sender,
            original.sender.clone(),
            serde_json::json!({"error": error_message}),
        );
        msg.reply_to = Some(original.id.clone());
        msg
    }

    /// Create a notification message.
    pub fn notification(
        sender: impl Into<String>,
        receiver: impl Into<String>,
        content: serde_json::Value,
    ) -> Self {
        Self::new(MessageType::Notification, sender, receiver, content)
    }

    /// Set metadata.
    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Serialize to JSON string.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON string.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_creation() {
        let msg = A2AMessage::request(
            "agent1",
            "agent2",
            serde_json::json!({"task": "summarize", "text": "Hello world"}),
        );

        assert_eq!(msg.message_type, MessageType::Request);
        assert_eq!(msg.sender, "agent1");
        assert_eq!(msg.receiver, "agent2");
        assert!(msg.reply_to.is_none());
    }

    #[test]
    fn test_response_creation() {
        let request = A2AMessage::request("agent1", "agent2", serde_json::json!({"query": "test"}));
        let response = A2AMessage::response(&request, "agent2", serde_json::json!({"result": "ok"}));

        assert_eq!(response.message_type, MessageType::Response);
        assert_eq!(response.receiver, "agent1");
        assert_eq!(response.reply_to, Some(request.id));
    }

    #[test]
    fn test_serialization() {
        let msg = A2AMessage::notification("agent1", "agent2", serde_json::json!({"event": "ready"}));

        let json = msg.to_json().unwrap();
        let parsed = A2AMessage::from_json(&json).unwrap();

        assert_eq!(parsed.id, msg.id);
        assert_eq!(parsed.message_type, MessageType::Notification);
    }
}
