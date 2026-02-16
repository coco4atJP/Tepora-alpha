// Graph State
// AgentState and related types for the StateGraph

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::context::pipeline_context::PipelineContext;
use crate::llm::ChatMessage;
use crate::tools::search::SearchResult;

/// Execution modes for the graph
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Chat,
    Search,
    SearchAgentic,
    Agent,
}

impl Mode {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "search_agentic" => Mode::SearchAgentic,
            "search" => Mode::Search,
            "agent" => Mode::Agent,
            _ => Mode::Chat,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Chat => "chat",
            Mode::Search => "search",
            Mode::SearchAgentic => "search_agentic",
            Mode::Agent => "agent",
        }
    }
}

/// Agent execution modes (for Agent mode routing)
///
/// - `Low`: Lightweight agent — skips planner unless complexity detected
/// - `High`: Full planning pipeline — always goes through Planner node
/// - `Direct`: Bypass supervisor, execute agent directly
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    #[default]
    Low,
    High,
    Direct,
}

impl AgentMode {
    pub fn from_str(s: Option<&str>) -> Self {
        match s.map(|v| v.trim().to_lowercase()).as_deref() {
            Some("high") => AgentMode::High,
            Some("direct") => AgentMode::Direct,
            // "fast" is accepted as legacy alias for "low"
            Some("low" | "fast") => AgentMode::Low,
            _ => AgentMode::Low,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AgentMode::Low => "low",
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

    // v4.0: Modular context pipeline output
    pub pipeline_context: Option<PipelineContext>,

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
            agent_mode: AgentMode::Low,
            selected_agent_id: None,
            supervisor_route: None,
            shared_context: SharedContext::default(),
            pipeline_context: None,
            agent_scratchpad: Vec::new(),
            agent_outcome: None,
            thinking_enabled: false,
            thought_process: None,
            search_queries: Vec::new(),
            search_results: None,
            search_attachments: Vec::new(),
            skip_web_search: false,
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
            pipeline_context: None,
            agent_scratchpad: Vec::new(),
            agent_outcome: None,
            thinking_enabled: thinking_mode,
            thought_process: None,
            search_queries: Vec::new(),
            search_results: None,
            search_attachments: attachments,
            skip_web_search,
            output: None,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // =======================================================================
    // Mode tests
    // =======================================================================

    #[test]
    fn mode_default_is_chat() {
        assert_eq!(Mode::default(), Mode::Chat);
    }

    #[test]
    fn mode_from_str_chat_variants() {
        assert_eq!(Mode::from_str("chat"), Mode::Chat);
        assert_eq!(Mode::from_str("CHAT"), Mode::Chat);
        assert_eq!(Mode::from_str("Chat"), Mode::Chat);
    }

    #[test]
    fn mode_from_str_search() {
        assert_eq!(Mode::from_str("search"), Mode::Search);
        assert_eq!(Mode::from_str("SEARCH"), Mode::Search);
    }

    #[test]
    fn mode_from_str_search_agentic() {
        assert_eq!(Mode::from_str("search_agentic"), Mode::SearchAgentic);
        assert_eq!(Mode::from_str("SEARCH_AGENTIC"), Mode::SearchAgentic);
    }

    #[test]
    fn mode_from_str_agent() {
        assert_eq!(Mode::from_str("agent"), Mode::Agent);
        assert_eq!(Mode::from_str("AGENT"), Mode::Agent);
    }

    #[test]
    fn mode_from_str_unknown_defaults_to_chat() {
        assert_eq!(Mode::from_str("unknown"), Mode::Chat);
        assert_eq!(Mode::from_str(""), Mode::Chat);
        assert_eq!(Mode::from_str("random"), Mode::Chat);
    }

    #[test]
    fn mode_as_str_roundtrip() {
        assert_eq!(Mode::Chat.as_str(), "chat");
        assert_eq!(Mode::Search.as_str(), "search");
        assert_eq!(Mode::SearchAgentic.as_str(), "search_agentic");
        assert_eq!(Mode::Agent.as_str(), "agent");

        // Roundtrip: as_str → from_str → same variant
        for mode in [Mode::Chat, Mode::Search, Mode::SearchAgentic, Mode::Agent] {
            assert_eq!(Mode::from_str(mode.as_str()), mode);
        }
    }

    #[test]
    fn mode_serialization_lowercase() {
        let serialized = serde_json::to_string(&Mode::SearchAgentic).unwrap();
        assert_eq!(serialized, "\"searchagentic\"");
    }

    // =======================================================================
    // AgentMode tests
    // =======================================================================

    #[test]
    fn agent_mode_default_is_low() {
        assert_eq!(AgentMode::default(), AgentMode::Low);
    }

    #[test]
    fn agent_mode_from_str_low() {
        assert_eq!(AgentMode::from_str(Some("low")), AgentMode::Low);
        assert_eq!(AgentMode::from_str(Some("LOW")), AgentMode::Low);
    }

    #[test]
    fn agent_mode_from_str_fast_alias() {
        // "fast" is accepted as a legacy alias for "low"
        assert_eq!(AgentMode::from_str(Some("fast")), AgentMode::Low);
        assert_eq!(AgentMode::from_str(Some("FAST")), AgentMode::Low);
    }

    #[test]
    fn agent_mode_from_str_high() {
        assert_eq!(AgentMode::from_str(Some("high")), AgentMode::High);
        assert_eq!(AgentMode::from_str(Some("HIGH")), AgentMode::High);
    }

    #[test]
    fn agent_mode_from_str_direct() {
        assert_eq!(AgentMode::from_str(Some("direct")), AgentMode::Direct);
        assert_eq!(AgentMode::from_str(Some("DIRECT")), AgentMode::Direct);
    }

    #[test]
    fn agent_mode_from_str_none_defaults_to_low() {
        assert_eq!(AgentMode::from_str(None), AgentMode::Low);
    }

    #[test]
    fn agent_mode_from_str_unknown_defaults_to_low() {
        assert_eq!(AgentMode::from_str(Some("unknown")), AgentMode::Low);
        assert_eq!(AgentMode::from_str(Some("")), AgentMode::Low);
    }

    #[test]
    fn agent_mode_from_str_trims_whitespace() {
        assert_eq!(AgentMode::from_str(Some("  high  ")), AgentMode::High);
        assert_eq!(AgentMode::from_str(Some(" direct ")), AgentMode::Direct);
    }

    #[test]
    fn agent_mode_as_str_roundtrip() {
        assert_eq!(AgentMode::Low.as_str(), "low");
        assert_eq!(AgentMode::High.as_str(), "high");
        assert_eq!(AgentMode::Direct.as_str(), "direct");

        for mode in [AgentMode::Low, AgentMode::High, AgentMode::Direct] {
            assert_eq!(AgentMode::from_str(Some(mode.as_str())), mode);
        }
    }

    // =======================================================================
    // SupervisorRoute tests
    // =======================================================================

    #[test]
    fn supervisor_route_serialization() {
        let planner = SupervisorRoute::Planner;
        let json = serde_json::to_string(&planner).unwrap();
        assert_eq!(json, "\"planner\"");

        let agent = SupervisorRoute::Agent("coder".to_string());
        let json = serde_json::to_string(&agent).unwrap();
        assert!(json.contains("coder"));
    }

    #[test]
    fn supervisor_route_equality() {
        assert_eq!(SupervisorRoute::Planner, SupervisorRoute::Planner);
        assert_eq!(
            SupervisorRoute::Agent("a".to_string()),
            SupervisorRoute::Agent("a".to_string())
        );
        assert_ne!(
            SupervisorRoute::Agent("a".to_string()),
            SupervisorRoute::Agent("b".to_string())
        );
        assert_ne!(
            SupervisorRoute::Planner,
            SupervisorRoute::Agent("planner".to_string())
        );
    }

    // =======================================================================
    // SharedContext tests
    // =======================================================================

    #[test]
    fn shared_context_default_is_empty() {
        let ctx = SharedContext::default();
        assert!(ctx.current_plan.is_none());
        assert!(ctx.artifacts.is_empty());
        assert!(ctx.notes.is_empty());
        assert!(ctx.professional_memory.is_none());
    }

    // =======================================================================
    // AgentState construction tests
    // =======================================================================

    #[test]
    fn agent_state_new_initializes_correctly() {
        let state = AgentState::new(
            "session-1".to_string(),
            "test input".to_string(),
            Mode::Search,
        );

        assert_eq!(state.session_id, "session-1");
        assert_eq!(state.input, "test input");
        assert_eq!(state.mode, Mode::Search);
        assert!(state.chat_history.is_empty());
        assert!(state.agent_id.is_none());
        assert_eq!(state.agent_mode, AgentMode::Low);
        assert!(state.selected_agent_id.is_none());
        assert!(state.supervisor_route.is_none());
        assert!(state.pipeline_context.is_none());
        assert!(state.agent_scratchpad.is_empty());
        assert!(state.agent_outcome.is_none());
        assert!(!state.thinking_enabled);
        assert!(state.thought_process.is_none());
        assert!(state.search_queries.is_empty());
        assert!(state.search_results.is_none());
        assert!(state.search_attachments.is_empty());
        assert!(!state.skip_web_search);
        assert!(state.output.is_none());
        assert!(state.error.is_none());
    }

    #[test]
    fn agent_state_from_ws_message_basic() {
        let state = AgentState::from_ws_message(
            "ws-session".to_string(),
            "hello",
            "chat",
            None,
            None,
            false,
            false,
            Vec::new(),
            Vec::new(),
        );

        assert_eq!(state.session_id, "ws-session");
        assert_eq!(state.input, "hello");
        assert_eq!(state.mode, Mode::Chat);
        assert!(state.agent_id.is_none());
        assert_eq!(state.agent_mode, AgentMode::Low);
        assert!(!state.thinking_enabled);
        assert!(!state.skip_web_search);
    }

    #[test]
    fn agent_state_from_ws_message_with_all_options() {
        let attachments = vec![serde_json::json!({"file": "test.txt"})];
        let state = AgentState::from_ws_message(
            "ws-session-2".to_string(),
            "complex query",
            "agent",
            Some("coder"),
            Some("high"),
            true,
            true,
            attachments.clone(),
            Vec::new(),
        );

        assert_eq!(state.mode, Mode::Agent);
        assert_eq!(state.agent_id.as_deref(), Some("coder"));
        assert_eq!(state.agent_mode, AgentMode::High);
        assert!(state.thinking_enabled);
        assert!(state.skip_web_search);
        assert_eq!(state.search_attachments.len(), 1);
    }

    #[test]
    fn agent_state_from_ws_message_fast_alias() {
        let state = AgentState::from_ws_message(
            "s".to_string(),
            "test",
            "agent",
            None,
            Some("fast"),
            false,
            false,
            Vec::new(),
            Vec::new(),
        );

        assert_eq!(state.agent_mode, AgentMode::Low);
    }

    // =======================================================================
    // Artifact tests
    // =======================================================================

    #[test]
    fn artifact_construction_and_serialization() {
        let artifact = Artifact {
            artifact_type: "code".to_string(),
            content: "fn main() {}".to_string(),
            metadata: HashMap::from([(
                "language".to_string(),
                serde_json::json!("rust"),
            )]),
        };

        let json = serde_json::to_string(&artifact).unwrap();
        assert!(json.contains("code"));
        assert!(json.contains("fn main"));
        assert!(json.contains("rust"));

        // Roundtrip
        let deserialized: Artifact = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.artifact_type, "code");
        assert_eq!(deserialized.content, "fn main() {}");
    }
}
