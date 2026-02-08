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
                GraphError::new(current_id, format!("Explicit target node not found: {}", next_id))
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
            self.runtime
                .add_conditional_edge(&from, &to, condition)?;
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

    #[test]
    fn test_edge_condition_matching() {
        assert!(EdgeCondition::Always.matches(None));
        assert!(!EdgeCondition::Always.matches(Some("chat")));

        assert!(EdgeCondition::on("chat").matches(Some("chat")));
        assert!(!EdgeCondition::on("chat").matches(Some("search")));
        assert!(!EdgeCondition::on("chat").matches(None));
    }
}
