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
