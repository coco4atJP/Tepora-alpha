// Graph Runtime - petgraph based
// Type-safe StateGraph execution engine

use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::EdgeRef;
use petgraph::Direction;
use std::collections::HashMap;

use super::node::{GraphError, Node, NodeContext, NodeOutput};
use super::state::AgentState;

/// Edge condition for graph routing
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EdgeCondition {
    /// Always follow this edge (default edge)
    Always,
    /// Follow this edge when the node returns this condition
    OnCondition(String),
}

impl EdgeCondition {
    pub fn always() -> Self {
        Self::Always
    }

    pub fn on(condition: impl Into<String>) -> Self {
        Self::OnCondition(condition.into())
    }

    pub fn matches(&self, condition: Option<&str>) -> bool {
        match (self, condition) {
            (EdgeCondition::Always, None) => true,
            (EdgeCondition::OnCondition(expected), Some(actual)) => expected == actual,
            _ => false,
        }
    }
}

/// petgraph-based StateGraph runtime
pub struct GraphRuntime {
    /// The underlying directed graph
    graph: DiGraph<Box<dyn Node>, EdgeCondition>,
    /// Map from node ID to NodeIndex for lookup
    node_indices: HashMap<String, NodeIndex>,
    /// Entry point node ID
    entry_node_id: String,
    /// Maximum execution steps (recursion limit)
    max_steps: usize,
}

impl GraphRuntime {
    /// Create a new graph runtime
    pub fn new() -> Self {
        Self {
            graph: DiGraph::new(),
            node_indices: HashMap::new(),
            entry_node_id: String::new(),
            max_steps: 50,
        }
    }

    /// Set maximum execution steps
    pub fn with_max_steps(mut self, max_steps: usize) -> Self {
        self.max_steps = max_steps;
        self
    }

    /// Set entry point node
    pub fn with_entry(mut self, node_id: impl Into<String>) -> Self {
        self.entry_node_id = node_id.into();
        self
    }

    /// Add a node to the graph
    pub fn add_node(&mut self, node: Box<dyn Node>) -> NodeIndex {
        let id = node.id().to_string();
        let index = self.graph.add_node(node);
        self.node_indices.insert(id, index);
        index
    }

    /// Add an edge between two nodes (always follow)
    pub fn add_edge(&mut self, from: &str, to: &str) -> Result<(), GraphError> {
        self.add_conditional_edge(from, to, EdgeCondition::Always)
    }

    /// Add a conditional edge between two nodes
    pub fn add_conditional_edge(
        &mut self,
        from: &str,
        to: &str,
        condition: EdgeCondition,
    ) -> Result<(), GraphError> {
        let from_idx = self
            .node_indices
            .get(from)
            .ok_or_else(|| GraphError::new(from, format!("Source node not found: {}", from)))?;
        let to_idx = self
            .node_indices
            .get(to)
            .ok_or_else(|| GraphError::new(to, format!("Target node not found: {}", to)))?;

        self.graph.add_edge(*from_idx, *to_idx, condition);
        Ok(())
    }

    /// Get node by ID
    pub fn get_node(&self, node_id: &str) -> Option<&dyn Node> {
        self.node_indices
            .get(node_id)
            .and_then(|idx| self.graph.node_weight(*idx))
            .map(|boxed| boxed.as_ref())
    }

    /// Get all node IDs
    pub fn node_ids(&self) -> Vec<&str> {
        self.node_indices.keys().map(|s| s.as_str()).collect()
    }

    /// Check for cycles in the graph (for debugging)
    pub fn has_cycle(&self) -> bool {
        petgraph::algo::is_cyclic_directed(&self.graph)
    }

    /// Execute the graph
    pub async fn run(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<(), GraphError> {
        if self.entry_node_id.is_empty() {
            return Err(GraphError::new("runtime", "No entry node set"));
        }

        let mut current_idx = *self.node_indices.get(&self.entry_node_id).ok_or_else(|| {
            GraphError::new(
                "runtime",
                format!("Entry node not found: {}", self.entry_node_id),
            )
        })?;

        let mut step = 0;

        loop {
            if step >= self.max_steps {
                return Err(GraphError::new(
                    "runtime",
                    format!("Maximum steps ({}) exceeded", self.max_steps),
                ));
            }

            let node = self
                .graph
                .node_weight(current_idx)
                .ok_or_else(|| GraphError::new("runtime", "Node not found in graph"))?;

            let node_id = node.id();
            tracing::debug!("Executing node: {} (step {})", node_id, step);

            let output = node.execute(state, ctx).await?;

            match output {
                NodeOutput::Final => {
                    tracing::debug!("Graph execution complete at node: {}", node_id);
                    return Ok(());
                }
                NodeOutput::Error(msg) => {
                    return Err(GraphError::new(node_id, msg));
                }
                NodeOutput::Continue(explicit_next) => {
                    current_idx =
                        self.resolve_next_node(current_idx, None, explicit_next.as_deref())?;
                }
                NodeOutput::Branch(condition) => {
                    current_idx = self.resolve_next_node(current_idx, Some(&condition), None)?;
                }
            }

            step += 1;
        }
    }

    /// Resolve the next node based on edges
    fn resolve_next_node(
        &self,
        current_idx: NodeIndex,
        condition: Option<&str>,
        explicit: Option<&str>,
    ) -> Result<NodeIndex, GraphError> {
        let current_id = self
            .graph
            .node_weight(current_idx)
            .map(|n| n.id())
            .unwrap_or("unknown");

        // If explicit next node is provided, use it
        if let Some(next_id) = explicit {
            return self.node_indices.get(next_id).copied().ok_or_else(|| {
                GraphError::new(
                    current_id,
                    format!("Explicit target node not found: {}", next_id),
                )
            });
        }

        // Find matching edge using neighbors and edge weights
        let mut edges_with_targets: Vec<(NodeIndex, &EdgeCondition)> = Vec::new();

        for edge_ref in self.graph.edges_directed(current_idx, Direction::Outgoing) {
            let target_idx = edge_ref.target();
            let weight = edge_ref.weight();
            edges_with_targets.push((target_idx, weight));
        }

        if edges_with_targets.is_empty() {
            return Err(GraphError::new(
                current_id,
                format!("No outgoing edges from node: {}", current_id),
            ));
        }

        // First, try to find an edge matching the condition
        if let Some(cond) = condition {
            for (target_idx, weight) in &edges_with_targets {
                if let EdgeCondition::OnCondition(expected) = weight {
                    if expected == cond {
                        return Ok(*target_idx);
                    }
                }
            }
        }

        // Fall back to default (Always) edge
        for (target_idx, weight) in &edges_with_targets {
            if **weight == EdgeCondition::Always {
                if condition.is_some() {
                    tracing::warn!(
                        "Condition '{}' not matched for node '{}', using default edge",
                        condition.unwrap_or(""),
                        current_id
                    );
                }
                return Ok(*target_idx);
            }
        }

        Err(GraphError::new(
            current_id,
            format!(
                "No matching edge for condition: {:?}",
                condition.unwrap_or("(none)")
            ),
        ))
    }
}

impl Default for GraphRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// Builder for constructing graphs fluently
pub struct GraphBuilder {
    runtime: GraphRuntime,
    pending_edges: Vec<(String, String, EdgeCondition)>,
}

impl GraphBuilder {
    pub fn new() -> Self {
        Self {
            runtime: GraphRuntime::new(),
            pending_edges: Vec::new(),
        }
    }

    pub fn entry(mut self, node_id: impl Into<String>) -> Self {
        self.runtime.entry_node_id = node_id.into();
        self
    }

    pub fn max_steps(mut self, max_steps: usize) -> Self {
        self.runtime.max_steps = max_steps;
        self
    }

    pub fn node(mut self, node: Box<dyn Node>) -> Self {
        self.runtime.add_node(node);
        self
    }

    pub fn edge(mut self, from: impl Into<String>, to: impl Into<String>) -> Self {
        self.pending_edges
            .push((from.into(), to.into(), EdgeCondition::Always));
        self
    }

    pub fn conditional_edge(
        mut self,
        from: impl Into<String>,
        to: impl Into<String>,
        condition: impl Into<String>,
    ) -> Self {
        self.pending_edges
            .push((from.into(), to.into(), EdgeCondition::on(condition)));
        self
    }

    pub fn build(mut self) -> Result<GraphRuntime, GraphError> {
        for (from, to, condition) in self.pending_edges {
            self.runtime.add_conditional_edge(&from, &to, condition)?;
        }
        Ok(self.runtime)
    }
}

impl Default for GraphBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
    use crate::graph::state::{AgentState, Mode};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // -----------------------------------------------------------------------
    // Mock Node implementations for testing graph execution without real
    // WebSocket / AppState dependencies.
    // -----------------------------------------------------------------------

    /// A simple node that records how many times it was called and returns
    /// a configurable output.
    struct MockNode {
        id: &'static str,
        output: NodeOutput,
        call_count: Arc<AtomicUsize>,
    }

    impl MockNode {
        fn new(id: &'static str, output: NodeOutput) -> Self {
            Self {
                id,
                output,
                call_count: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn with_counter(id: &'static str, output: NodeOutput, counter: Arc<AtomicUsize>) -> Self {
            Self {
                id,
                output,
                call_count: counter,
            }
        }
    }

    #[async_trait]
    impl Node for MockNode {
        fn id(&self) -> &'static str {
            self.id
        }

        async fn execute(
            &self,
            _state: &mut AgentState,
            _ctx: &mut NodeContext<'_>,
        ) -> Result<NodeOutput, GraphError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);
            Ok(self.output.clone())
        }
    }

    /// Helper: create a default AgentState for testing
    fn test_state() -> AgentState {
        AgentState::new("test-session".to_string(), "hello".to_string(), Mode::Chat)
    }

    // =======================================================================
    // EdgeCondition tests
    // =======================================================================

    #[test]
    fn test_edge_condition_matching() {
        assert!(EdgeCondition::Always.matches(None));
        assert!(!EdgeCondition::Always.matches(Some("chat")));

        assert!(EdgeCondition::on("chat").matches(Some("chat")));
        assert!(!EdgeCondition::on("chat").matches(Some("search")));
        assert!(!EdgeCondition::on("chat").matches(None));
    }

    #[test]
    fn edge_condition_always_constructor() {
        let cond = EdgeCondition::always();
        assert_eq!(cond, EdgeCondition::Always);
    }

    #[test]
    fn edge_condition_on_constructor() {
        let cond = EdgeCondition::on("agent");
        assert_eq!(cond, EdgeCondition::OnCondition("agent".to_string()));
    }

    #[test]
    fn edge_condition_debug_and_clone() {
        let cond = EdgeCondition::on("test");
        let cloned = cond.clone();
        assert_eq!(cond, cloned);
        // Verify Debug is implemented
        let debug_str = format!("{:?}", cond);
        assert!(debug_str.contains("test"));
    }

    // =======================================================================
    // GraphRuntime construction tests
    // =======================================================================

    #[test]
    fn new_runtime_has_no_nodes() {
        let runtime = GraphRuntime::new();
        assert!(runtime.node_ids().is_empty());
        assert!(!runtime.has_cycle());
    }

    #[test]
    fn default_runtime_equals_new() {
        let runtime = GraphRuntime::default();
        assert!(runtime.node_ids().is_empty());
    }

    #[test]
    fn add_node_returns_index_and_is_retrievable() {
        let mut runtime = GraphRuntime::new();
        let node = MockNode::new("alpha", NodeOutput::Final);
        let _idx = runtime.add_node(Box::new(node));

        assert_eq!(runtime.node_ids().len(), 1);
        assert!(runtime.get_node("alpha").is_some());
        assert_eq!(runtime.get_node("alpha").unwrap().id(), "alpha");
    }

    #[test]
    fn get_node_returns_none_for_unknown() {
        let runtime = GraphRuntime::new();
        assert!(runtime.get_node("nonexistent").is_none());
    }

    #[test]
    fn add_multiple_nodes() {
        let mut runtime = GraphRuntime::new();
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("c", NodeOutput::Final)));

        assert_eq!(runtime.node_ids().len(), 3);
        assert!(runtime.get_node("a").is_some());
        assert!(runtime.get_node("b").is_some());
        assert!(runtime.get_node("c").is_some());
    }

    // =======================================================================
    // Edge management tests
    // =======================================================================

    #[test]
    fn add_edge_succeeds_for_existing_nodes() {
        let mut runtime = GraphRuntime::new();
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));

        let result = runtime.add_edge("a", "b");
        assert!(result.is_ok());
    }

    #[test]
    fn add_edge_fails_for_missing_source() {
        let mut runtime = GraphRuntime::new();
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));

        let result = runtime.add_edge("a", "b");
        assert!(result.is_err());
    }

    #[test]
    fn add_edge_fails_for_missing_target() {
        let mut runtime = GraphRuntime::new();
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));

        let result = runtime.add_edge("a", "b");
        assert!(result.is_err());
    }

    #[test]
    fn add_conditional_edge_succeeds() {
        let mut runtime = GraphRuntime::new();
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));

        let result = runtime.add_conditional_edge("a", "b", EdgeCondition::on("chat"));
        assert!(result.is_ok());
    }

    // =======================================================================
    // Cycle detection tests
    // =======================================================================

    #[test]
    fn has_cycle_detects_cycle() {
        let mut runtime = GraphRuntime::new();
        runtime.add_node(Box::new(MockNode::new(
            "a",
            NodeOutput::Continue(Some("b".to_string())),
        )));
        runtime.add_node(Box::new(MockNode::new(
            "b",
            NodeOutput::Continue(Some("a".to_string())),
        )));
        runtime.add_edge("a", "b").unwrap();
        runtime.add_edge("b", "a").unwrap();

        assert!(runtime.has_cycle());
    }

    #[test]
    fn has_cycle_returns_false_for_dag() {
        let mut runtime = GraphRuntime::new();
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("c", NodeOutput::Final)));
        runtime.add_edge("a", "b").unwrap();
        runtime.add_edge("b", "c").unwrap();

        assert!(!runtime.has_cycle());
    }

    // =======================================================================
    // Builder pattern tests (with_max_steps, with_entry)
    // =======================================================================

    #[test]
    fn with_max_steps_sets_value() {
        let runtime = GraphRuntime::new().with_max_steps(100);
        assert_eq!(runtime.max_steps, 100);
    }

    #[test]
    fn with_entry_sets_entry_node() {
        let runtime = GraphRuntime::new().with_entry("start");
        assert_eq!(runtime.entry_node_id, "start");
    }

    // =======================================================================
    // GraphBuilder tests
    // =======================================================================

    #[test]
    fn graph_builder_default_equals_new() {
        let builder1 = GraphBuilder::new();
        let builder2 = GraphBuilder::default();
        // Both should produce empty runtimes
        let rt1 = builder1.build();
        let rt2 = builder2.build();
        assert!(rt1.is_ok());
        assert!(rt2.is_ok());
    }

    #[test]
    fn graph_builder_builds_simple_graph() {
        let result = GraphBuilder::new()
            .entry("start")
            .max_steps(10)
            .node(Box::new(MockNode::new("start", NodeOutput::Final)))
            .node(Box::new(MockNode::new("end", NodeOutput::Final)))
            .edge("start", "end")
            .build();

        assert!(result.is_ok());
        let runtime = result.unwrap();
        assert_eq!(runtime.node_ids().len(), 2);
    }

    #[test]
    fn graph_builder_with_conditional_edges() {
        let result = GraphBuilder::new()
            .entry("router")
            .node(Box::new(MockNode::new(
                "router",
                NodeOutput::Branch("chat".to_string()),
            )))
            .node(Box::new(MockNode::new("chat", NodeOutput::Final)))
            .node(Box::new(MockNode::new("search", NodeOutput::Final)))
            .conditional_edge("router", "chat", "chat")
            .conditional_edge("router", "search", "search")
            .build();

        assert!(result.is_ok());
        let runtime = result.unwrap();
        assert_eq!(runtime.node_ids().len(), 3);
    }

    #[test]
    fn graph_builder_fails_with_missing_node_in_edge() {
        let result = GraphBuilder::new()
            .entry("start")
            .node(Box::new(MockNode::new("start", NodeOutput::Final)))
            .edge("start", "nonexistent")
            .build();

        assert!(result.is_err());
    }

    #[test]
    fn graph_builder_entry_and_max_steps() {
        let result = GraphBuilder::new()
            .entry("first")
            .max_steps(25)
            .node(Box::new(MockNode::new("first", NodeOutput::Final)))
            .build();

        assert!(result.is_ok());
        let runtime = result.unwrap();
        assert_eq!(runtime.max_steps, 25);
        assert_eq!(runtime.entry_node_id, "first");
    }

    // =======================================================================
    // GraphRuntime::run() tests
    //
    // These tests use a technique: since NodeContext requires a real
    // WebSocket sender and AppState, our MockNode::execute ignores ctx
    // entirely, which means we can create a minimal "dummy" NodeContext.
    // However, NodeContext borrows real types. Instead we test run() logic
    // indirectly through the builder + resolve_next_node patterns, and
    // verify the structural correctness that doesn't require async execution.
    //
    // For the run() method, we test error conditions that can be checked
    // without invoking execute().
    // =======================================================================

    #[test]
    fn resolve_next_node_finds_always_edge() {
        let mut runtime = GraphRuntime::new().with_entry("a");
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));
        runtime.add_edge("a", "b").unwrap();

        let idx_a = *runtime.node_indices.get("a").unwrap();
        let result = runtime.resolve_next_node(idx_a, None, None);
        assert!(result.is_ok());

        let idx_b = *runtime.node_indices.get("b").unwrap();
        assert_eq!(result.unwrap(), idx_b);
    }

    #[test]
    fn resolve_next_node_finds_conditional_edge() {
        let mut runtime = GraphRuntime::new().with_entry("router");
        runtime.add_node(Box::new(MockNode::new("router", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("chat", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("search", NodeOutput::Final)));

        runtime
            .add_conditional_edge("router", "chat", EdgeCondition::on("chat"))
            .unwrap();
        runtime
            .add_conditional_edge("router", "search", EdgeCondition::on("search"))
            .unwrap();

        let idx_router = *runtime.node_indices.get("router").unwrap();

        // Condition "chat" should resolve to chat node
        let result_chat = runtime.resolve_next_node(idx_router, Some("chat"), None);
        assert!(result_chat.is_ok());
        assert_eq!(
            result_chat.unwrap(),
            *runtime.node_indices.get("chat").unwrap()
        );

        // Condition "search" should resolve to search node
        let result_search = runtime.resolve_next_node(idx_router, Some("search"), None);
        assert!(result_search.is_ok());
        assert_eq!(
            result_search.unwrap(),
            *runtime.node_indices.get("search").unwrap()
        );
    }

    #[test]
    fn resolve_next_node_explicit_overrides_edges() {
        let mut runtime = GraphRuntime::new().with_entry("a");
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("c", NodeOutput::Final)));
        runtime.add_edge("a", "b").unwrap();

        let idx_a = *runtime.node_indices.get("a").unwrap();
        // Explicit "c" should override the edge to "b"
        let result = runtime.resolve_next_node(idx_a, None, Some("c"));
        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            *runtime.node_indices.get("c").unwrap()
        );
    }

    #[test]
    fn resolve_next_node_explicit_fails_for_unknown_node() {
        let mut runtime = GraphRuntime::new().with_entry("a");
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));
        runtime.add_edge("a", "b").unwrap();

        let idx_a = *runtime.node_indices.get("a").unwrap();
        let result = runtime.resolve_next_node(idx_a, None, Some("nonexistent"));
        assert!(result.is_err());
    }

    #[test]
    fn resolve_next_node_no_outgoing_edges_errors() {
        let mut runtime = GraphRuntime::new().with_entry("a");
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));

        let idx_a = *runtime.node_indices.get("a").unwrap();
        let result = runtime.resolve_next_node(idx_a, None, None);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .message
            .contains("No outgoing edges"));
    }

    #[test]
    fn resolve_next_node_unmatched_condition_falls_back_to_always() {
        let mut runtime = GraphRuntime::new().with_entry("a");
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("c", NodeOutput::Final)));

        // Add a conditional edge and a default (always) edge
        runtime
            .add_conditional_edge("a", "b", EdgeCondition::on("match_me"))
            .unwrap();
        runtime.add_edge("a", "c").unwrap(); // Always edge (fallback)

        let idx_a = *runtime.node_indices.get("a").unwrap();

        // Unmatched condition should fall back to Always edge → c
        let result = runtime.resolve_next_node(idx_a, Some("no_match"), None);
        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            *runtime.node_indices.get("c").unwrap()
        );
    }

    #[test]
    fn resolve_next_node_unmatched_condition_no_fallback_errors() {
        let mut runtime = GraphRuntime::new().with_entry("a");
        runtime.add_node(Box::new(MockNode::new("a", NodeOutput::Final)));
        runtime.add_node(Box::new(MockNode::new("b", NodeOutput::Final)));

        runtime
            .add_conditional_edge("a", "b", EdgeCondition::on("specific"))
            .unwrap();

        let idx_a = *runtime.node_indices.get("a").unwrap();

        // "other" doesn't match "specific" and there is no Always edge
        let result = runtime.resolve_next_node(idx_a, Some("other"), None);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .message
            .contains("No matching edge"));
    }

    // =======================================================================
    // GraphError conversion and display tests
    // =======================================================================

    #[test]
    fn graph_error_display() {
        let err = GraphError::new("node1", "something went wrong");
        let display = format!("{}", err);
        assert!(display.contains("node1"));
        assert!(display.contains("something went wrong"));
    }

    #[test]
    fn graph_error_converts_to_api_error() {
        use crate::core::errors::ApiError;
        let graph_err = GraphError::new("test_node", "failure reason");
        let api_err: ApiError = graph_err.into();
        let msg = format!("{}", api_err);
        assert!(msg.contains("test_node"));
        assert!(msg.contains("failure reason"));
    }
}
