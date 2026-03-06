pub mod loader;
pub mod node;
pub mod nodes;
pub mod runtime;
pub mod schema;
pub mod state;
pub mod stream;

pub use node::NodeContext;
pub use runtime::{GraphBuilder, GraphRuntime};
pub use state::{AgentState, Mode};

// Factory function
use crate::core::config::ConfigService;
use serde_json::Value;

pub fn build_tepora_graph(
    config_service: &ConfigService,
) -> Result<GraphRuntime, crate::state::error::InitializationError> {
    let config = config_service.load_config().unwrap_or(Value::Null);

    let mut builder = GraphBuilder::new()
        .entry("router")
        .max_steps(50)
        .node(Box::new(nodes::router::RouterNode::new()))
        .node(Box::new(nodes::chat::ChatNode::new()))
        .node(Box::new(nodes::planner::PlannerNode::new()))
        .node(Box::new(nodes::supervisor::SupervisorNode::new()))
        .node(Box::new(nodes::agent_executor::AgentExecutorNode::new()))
        .node(Box::new(nodes::search_agentic::AgenticSearchNode::new()))
        .node(Box::new(nodes::synthesizer::SynthesizerNode::new()));

    if config
        .get("app")
        .and_then(|v| v.get("experimental_thinking_pipeline"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        builder = builder.node(Box::new(nodes::thinking::ThinkingNode::new()));
        builder = builder.edge("thinking", "supervisor");
    }

    builder
        .conditional_edge("router", "chat", "chat")
        .conditional_edge("router", "planner", "plan")
        .conditional_edge("router", "agent_executor", "agent")
        .conditional_edge("router", "search_agentic", "search")
        .conditional_edge("planner", "supervisor", "supervisor")
        .conditional_edge("supervisor", "search_agentic", "search")
        .conditional_edge("supervisor", "agent_executor", "agent")
        .conditional_edge("supervisor", "synthesizer", "synthesize")
        .edge("search_agentic", "supervisor")
        .edge("agent_executor", "supervisor")
        .build()
        .map_err(|e| crate::state::error::InitializationError::Graph(e.into()))
}
