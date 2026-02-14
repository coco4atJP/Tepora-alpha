// Graph Builder
// Constructs the complete Tepora graph using petgraph

use super::node::GraphError;
use super::nodes::{
    AgentExecutorNode, AgenticSearchNode, ChatNode, PlannerNode, RouterNode, SearchNode,
    SupervisorNode, SynthesizerNode, ThinkingNode,
};
use super::runtime::{GraphBuilder, GraphRuntime};

/// Build the main Tepora graph
pub fn build_tepora_graph() -> Result<GraphRuntime, GraphError> {
    GraphBuilder::new()
        .entry("router")
        .max_steps(50)
        // Entry point
        .node(Box::new(RouterNode::new()))
        // Chat mode path
        .node(Box::new(ThinkingNode::new()))
        .node(Box::new(ChatNode::new()))
        // Search mode path (Fast + Agentic)
        .node(Box::new(SearchNode::new()))
        .node(Box::new(AgenticSearchNode::new()))
        // Agent mode path
        .node(Box::new(SupervisorNode::new()))
        .node(Box::new(PlannerNode::new()))
        .node(Box::new(AgentExecutorNode::new()))
        .node(Box::new(SynthesizerNode::new()))
        // Router edges (conditional routing based on mode)
        .conditional_edge("router", "thinking", "thinking")
        .conditional_edge("router", "chat", "chat")
        .conditional_edge("router", "search", "search")
        .conditional_edge("router", "search_agentic", "search_agentic")
        .conditional_edge("router", "supervisor", "supervisor")
        // Thinking -> Chat (default edge)
        .edge("thinking", "chat")
        // Supervisor edges (conditional routing based on agent_mode)
        .conditional_edge("supervisor", "planner", "planner")
        .conditional_edge("supervisor", "agent_executor", "direct")
        // Planner -> Agent Executor (default edge)
        .edge("planner", "agent_executor")
        // Build the graph
        .build()
}
