use super::node::{GraphError, Node};
use super::nodes::{
    AgentExecutorNode, AgenticSearchNode, ChatNode, PlannerNode, RouterNode, SearchNode,
    SupervisorNode, SynthesizerNode, ThinkingNode, ToolNode,
};
use super::runtime::{GraphBuilder, GraphRuntime};
use super::schema::WorkflowDef;
use serde_json::Value;

/// Instantiate a Node implementation based on the `type` string in the JSON schema.
/// Provides a fallback mechanism.
/// Note: Any unknown "metadata" properties (e.g. GUI layout, dimensions, labels, colors)
/// are strictly serialized/deserialized seamlessly as `serde_json::Value` by the schema layout.
/// This preserves them for front-end usage even if the backend engine ignores them.
fn instantiate_node(
    node_type: &str,
    _id: &str,
    _metadata: &Value,
) -> Result<Box<dyn Node>, GraphError> {
    match node_type {
        "RouterNode" => Ok(Box::new(RouterNode::new())),
        "ThinkingNode" => Ok(Box::new(ThinkingNode::new())),
        "ChatNode" => Ok(Box::new(ChatNode::new())),
        "SearchNode" => Ok(Box::new(SearchNode::new())),
        "AgenticSearchNode" => Ok(Box::new(AgenticSearchNode::new())),
        "SupervisorNode" => Ok(Box::new(SupervisorNode::new())),
        "PlannerNode" => Ok(Box::new(PlannerNode::new())),
        "AgentExecutorNode" => Ok(Box::new(AgentExecutorNode::new())),
        "SynthesizerNode" => Ok(Box::new(SynthesizerNode::new())),
        "ToolNode" => {
            let tool_name = _metadata
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("default_tool")
                .to_string();
            let tool_args = _metadata.get("tool_args").cloned().unwrap_or(Value::Null);
            Ok(Box::new(ToolNode::new(tool_name, tool_args)))
        }
        _ => Err(GraphError::new(
            "loader",
            format!(
                "Unknown node type '{}' requested via JSON schema",
                node_type
            ),
        )),
    }
}

/// Loads a `GraphRuntime` from a defined `WorkflowDef` (JSON structural definition).
pub fn load_workflow_from_json(def: &WorkflowDef) -> Result<GraphRuntime, GraphError> {
    let mut builder = GraphBuilder::new().entry(&def.entry_node);

    if let Some(max_steps) = def.max_steps {
        builder = builder.max_steps(max_steps);
    }

    if let Some(timeout_ms) = def.execution_timeout_ms {
        builder = builder.timeout(std::time::Duration::from_millis(timeout_ms));
    }

    // 1. Instantiate Nodes
    for node_def in &def.nodes {
        let node_impl = instantiate_node(&node_def.node_type, &node_def.id, &node_def.metadata)?;
        builder = builder.node_with_id(node_def.id.clone(), node_impl);
    }

    // 2. Wire up edges
    for edge in &def.edges {
        if let Some(condition) = &edge.condition {
            builder = builder.conditional_edge(&edge.from, &edge.to, condition);
        } else {
            builder = builder.edge(&edge.from, &edge.to);
        }
    }

    builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixture_path(relative: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
    }

    fn normalize_newlines(value: &str) -> String {
        value.replace("\r\n", "\n")
    }

    fn read_fixture(relative: &str) -> String {
        let path = fixture_path(relative);
        fs::read_to_string(&path).expect("fixture should be readable")
    }

    fn canonical_workflow_json(relative: &str) -> String {
        let raw = read_fixture(relative);
        let value: serde_json::Value =
            serde_json::from_str(&raw).expect("fixture should be valid json");
        let workflow: WorkflowDef =
            serde_json::from_value(value).expect("fixture should deserialize");
        let serialized = serde_json::to_string_pretty(&workflow)
            .expect("workflow should serialize in canonical form");
        format!("{}\n", serialized)
    }

    fn assert_workflow_fixture(
        input_relative: &str,
        golden_relative: &str,
        expected_nodes: &[&str],
    ) {
        let input_path = fixture_path(input_relative);
        let raw = read_fixture(input_relative);
        let value: serde_json::Value =
            serde_json::from_str(&raw).expect("fixture should be valid json");

        assert!(
            crate::graph::schema::validate_workflow_json(&value).is_ok(),
            "fixture should satisfy workflow schema: {}",
            input_path.display()
        );

        let workflow: WorkflowDef =
            serde_json::from_value(value).expect("fixture should deserialize");
        let runtime =
            load_workflow_from_json(&workflow).expect("fixture should load into graph runtime");
        let golden = read_fixture(golden_relative);

        assert_eq!(
            canonical_workflow_json(input_relative),
            normalize_newlines(&golden)
        );
        assert_eq!(runtime.node_ids().len(), expected_nodes.len());
        for node_id in expected_nodes {
            assert!(
                runtime.get_node(node_id).is_some(),
                "missing node {node_id}"
            );
        }
    }

    #[test]
    fn default_workflow_json_matches_golden_fixture() {
        assert_workflow_fixture(
            "workflows/default.json",
            "tests/fixtures/workflows/default.canonical.json",
            &[
                "router",
                "chat",
                "planner",
                "supervisor",
                "agent_executor",
                "search_agentic",
                "synthesizer",
                "thinking",
            ],
        );
    }

    #[test]
    fn tool_node_workflow_fixture_matches_golden_fixture() {
        assert_workflow_fixture(
            "tests/fixtures/workflows/tool_node.json",
            "tests/fixtures/workflows/tool_node.canonical.json",
            &["tool_call", "chat"],
        );
    }
}
