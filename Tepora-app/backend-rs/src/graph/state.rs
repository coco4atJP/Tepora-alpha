// Graph State
// AgentState and related types for the StateGraph

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::llama::ChatMessage;
use crate::search::SearchResult;

/// Execution modes for the graph
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Chat,
    Search,
    Agent,
}

impl Mode {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "search" => Mode::Search,
            "agent" => Mode::Agent,
            _ => Mode::Chat,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Chat => "chat",
            Mode::Search => "search",
            Mode::Agent => "agent",
        }
    }
}

/// Agent execution modes (for Agent mode routing)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    #[default]
    Fast,
    High,
    Direct,
}

impl AgentMode {
    pub fn from_str(s: Option<&str>) -> Self {
        match s.map(|v| v.trim().to_lowercase()).as_deref() {
            Some("high") => AgentMode::High,
            Some("direct") => AgentMode::Direct,
            _ => AgentMode::Fast,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AgentMode::Fast => "fast",
            AgentMode::High => "high",
            AgentMode::Direct => "direct",
        }
    }
}

/// Supervisor routing decisions
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorRoute {
    Planner,
    Agent(String),
}

/// Artifact stored in shared context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub artifact_type: String,
    pub content: String,
    pub metadata: HashMap<String, Value>,
}

/// Shared context for agents
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SharedContext {
    /// Current execution plan from Planner
    pub current_plan: Option<String>,
    /// Artifacts (code snippets, search results, etc.)
    pub artifacts: Vec<Artifact>,
    /// Scratchpad notes for agents
    pub notes: Vec<String>,
    /// Professional memory (retrieved from past tasks)
    pub professional_memory: Option<String>,
}

/// Main graph state
#[derive(Debug, Clone)]
pub struct AgentState {
    // Session identifier
    pub session_id: String,

    // Core input and history
    pub input: String,
    pub mode: Mode,
    pub chat_history: Vec<ChatMessage>,

    // Hierarchical agent routing
    pub agent_id: Option<String>,
    pub agent_mode: AgentMode,
    pub selected_agent_id: Option<String>,
    pub supervisor_route: Option<SupervisorRoute>,

    // Shared context for agents
    pub shared_context: SharedContext,

    // Agent ReAct loop state
    pub agent_scratchpad: Vec<ChatMessage>,
    pub agent_outcome: Option<String>,

    // Thinking mode (CoT)
    pub thinking_enabled: bool,
    pub thought_process: Option<String>,

    // Search mode state
    pub search_queries: Vec<String>,
    pub search_results: Option<Vec<SearchResult>>,
    pub search_attachments: Vec<Value>,
    pub skip_web_search: bool,

    // Generation metadata
    pub generation_logprobs: Option<Value>,

    // Final output
    pub output: Option<String>,
    pub error: Option<String>,
}

impl AgentState {
    pub fn new(session_id: String, input: String, mode: Mode) -> Self {
        Self {
            session_id,
            input,
            mode,
            chat_history: Vec::new(),
            agent_id: None,
            agent_mode: AgentMode::Fast,
            selected_agent_id: None,
            supervisor_route: None,
            shared_context: SharedContext::default(),
            agent_scratchpad: Vec::new(),
            agent_outcome: None,
            thinking_enabled: false,
            thought_process: None,
            search_queries: Vec::new(),
            search_results: None,
            search_attachments: Vec::new(),
            skip_web_search: false,
            generation_logprobs: None,
            output: None,
            error: None,
        }
    }

    /// Create state from WebSocket message data
    #[allow(clippy::too_many_arguments)]
    pub fn from_ws_message(
        session_id: String,
        message: &str,
        mode: &str,
        agent_id: Option<&str>,
        agent_mode: Option<&str>,
        thinking_mode: bool,
        skip_web_search: bool,
        attachments: Vec<Value>,
        chat_history: Vec<ChatMessage>,
    ) -> Self {
        Self {
            session_id,
            input: message.to_string(),
            mode: Mode::from_str(mode),
            chat_history,
            agent_id: agent_id.map(String::from),
            agent_mode: AgentMode::from_str(agent_mode),
            selected_agent_id: None,
            supervisor_route: None,
            shared_context: SharedContext::default(),
            agent_scratchpad: Vec::new(),
            agent_outcome: None,
            thinking_enabled: thinking_mode,
            thought_process: None,
            search_queries: Vec::new(),
            search_results: None,
            search_attachments: attachments,
            skip_web_search,
            generation_logprobs: None,
            output: None,
            error: None,
        }
    }
}
