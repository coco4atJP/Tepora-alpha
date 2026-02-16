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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_tepora_graph_succeeds() {
        let result = build_tepora_graph();
        assert!(result.is_ok(), "build_tepora_graph() should succeed");
    }

    #[test]
    fn tepora_graph_has_all_expected_nodes() {
        let graph = build_tepora_graph().unwrap();
        let ids = graph.node_ids();

        let expected_nodes = [
            "router",
            "thinking",
            "chat",
            "search",
            "search_agentic",
            "supervisor",
            "planner",
            "agent_executor",
            "synthesizer",
        ];

        for node_id in &expected_nodes {
            assert!(
                ids.contains(node_id),
                "Graph should contain node '{}', found: {:?}",
                node_id,
                ids
            );
        }

        assert_eq!(
            ids.len(),
            expected_nodes.len(),
            "Graph should have exactly {} nodes, found {}",
            expected_nodes.len(),
            ids.len()
        );
    }

    #[test]
    fn tepora_graph_nodes_have_correct_ids() {
        let graph = build_tepora_graph().unwrap();

        // Verify each node is retrievable and has the correct id
        assert_eq!(graph.get_node("router").unwrap().id(), "router");
        assert_eq!(graph.get_node("thinking").unwrap().id(), "thinking");
        assert_eq!(graph.get_node("chat").unwrap().id(), "chat");
        assert_eq!(graph.get_node("search").unwrap().id(), "search");
        assert_eq!(
            graph.get_node("search_agentic").unwrap().id(),
            "search_agentic"
        );
        assert_eq!(graph.get_node("supervisor").unwrap().id(), "supervisor");
        assert_eq!(graph.get_node("planner").unwrap().id(), "planner");
        assert_eq!(
            graph.get_node("agent_executor").unwrap().id(),
            "agent_executor"
        );
        assert_eq!(graph.get_node("synthesizer").unwrap().id(), "synthesizer");
    }

    #[test]
    fn tepora_graph_nodes_have_human_readable_names() {
        let graph = build_tepora_graph().unwrap();

        // All nodes must have a non-empty name
        for node_id in graph.node_ids() {
            let node = graph.get_node(node_id).unwrap();
            assert!(
                !node.name().is_empty(),
                "Node '{}' should have a non-empty name()",
                node_id
            );
        }
    }

    #[test]
    fn tepora_graph_has_cycles() {
        // The Tepora graph is expected to potentially have cycles
        // (e.g., supervisor <-> planner feedback loops, or agent
        // loops). Verify the cycle-detection utility works.
        let graph = build_tepora_graph().unwrap();
        // Note: This graph does NOT have cycles (all edges go forward).
        // The max_steps guard handles any logical loops in node output.
        assert!(
            !graph.has_cycle(),
            "Tepora graph structure should be a DAG (cycles are handled via max_steps in run())"
        );
    }
}
