// Node trait and types
// Base abstraction for graph nodes

use async_trait::async_trait;
use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::SplitSink;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::core::errors::ApiError;
use crate::state::AppState;

use super::state::AgentState;

/// Context passed to nodes during execution
pub struct NodeContext<'a> {
    /// Application state (llama, config, mcp, etc.)
    pub app_state: &'a AppState,
    /// Configuration
    pub config: &'a Value,
    /// WebSocket sender for streaming
    pub sender: &'a mut SplitSink<WebSocket, Message>,
    /// Pending tool approvals
    pub pending_approvals: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    /// Approved MCP tools for this session
    pub approved_mcp_tools: Arc<Mutex<HashSet<String>>>,
}

/// Output from a node execution
#[derive(Debug, Clone)]
pub enum NodeOutput {
    /// Continue to the specified next node (None = use default edge)
    Continue(Option<String>),
    /// Branch to one of the specified nodes based on condition
    Branch(String),
    /// Graph execution complete
    Final,
    /// Error occurred
    Error(String),
}

/// Graph execution error
#[derive(Debug, Clone)]
pub struct GraphError {
    pub node_id: String,
    pub message: String,
}

impl GraphError {
    pub fn new(node_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            node_id: node_id.into(),
            message: message.into(),
        }
    }
}

impl From<GraphError> for ApiError {
    fn from(err: GraphError) -> Self {
        ApiError::internal(format!("Graph error in {}: {}", err.node_id, err.message))
    }
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "GraphError in {}: {}", self.node_id, self.message)
    }
}

impl std::error::Error for GraphError {}

/// Node trait - all graph nodes implement this
#[async_trait]
pub trait Node: Send + Sync {
    /// Unique identifier for this node
    fn id(&self) -> &'static str;

    /// Human-readable name for display
    fn name(&self) -> &'static str {
        self.id()
    }

    /// Execute the node logic
    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError>;
}
