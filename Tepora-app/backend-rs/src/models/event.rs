use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The types of agentic events we track in the system.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventType {
    /// When an executable graph node starts processing
    NodeStarted,
    /// When an executable graph node completes successfully
    NodeCompleted,
    /// When the LLM generates a prompt/response (includes token usage)
    PromptGenerated,
    /// When the agent decides to invoke a tool
    ToolCall,
    /// When an error occurs during reasoning or tool execution
    Error,
}

impl AgentEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NodeStarted => "node_started",
            Self::NodeCompleted => "node_completed",
            Self::PromptGenerated => "prompt_generated",
            Self::ToolCall => "tool_call",
            Self::Error => "error",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "node_started" => Some(Self::NodeStarted),
            "node_completed" => Some(Self::NodeCompleted),
            "prompt_generated" => Some(Self::PromptGenerated),
            "tool_call" => Some(Self::ToolCall),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

/// An analytical event recording agent telemetry and metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    /// Unique identifier for the event
    pub id: String,
    /// The session this event belongs to
    pub session_id: String,
    /// The name of the Graph node executing (e.g., "agent", "thinking", "tools")
    pub node_name: String,
    /// The specific type of the event occurring
    pub event_type: AgentEventType,
    /// JSON metadata payload (e.g. token_usage, latency_ms, tool_name, etc.)
    pub metadata: Value,
    /// When the event occurred
    pub created_at: DateTime<Utc>,
}
