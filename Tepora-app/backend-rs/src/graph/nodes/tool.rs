// Tool Node
// Handles tool execution with approval flow

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::tools::execute_tool;
use crate::server::ws::handler::send_json;

pub struct ToolNode {
    tool_name: String,
    tool_args: Value,
}

impl ToolNode {
    pub fn new(tool_name: String, tool_args: Value) -> Self {
        Self {
            tool_name,
            tool_args,
        }
    }
}

#[async_trait]
impl Node for ToolNode {
    fn id(&self) -> &'static str {
        "tool"
    }

    fn name(&self) -> &'static str {
        "Tool Node"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "tool_execution",
                    "status": "processing",
                    "message": format!("Executing tool: {}", self.tool_name),
                    "agentName": "Tool Handler"
                }
            }),
        )
        .await;

        // Execute tool
        let result = execute_tool(
            ctx.config,
            Some(&ctx.app_state.mcp),
            &self.tool_name,
            &self.tool_args,
        )
        .await;

        match result {
            Ok(execution) => {
                // Send search results if available
                if let Some(results) = &execution.search_results {
                    let _ = send_json(
                        ctx.sender,
                        json!({ "type": "search_results", "data": results }),
                    )
                    .await;
                }

                // Add tool result to scratchpad
                state.agent_scratchpad.push(crate::llama::ChatMessage {
                    role: "system".to_string(),
                    content: format!("Tool `{}` result:\n{}", self.tool_name, execution.output),
                });

                let _ = send_json(
                    ctx.sender,
                    json!({
                        "type": "activity",
                        "data": {
                            "id": "tool_execution",
                            "status": "done",
                            "message": format!("Tool `{}` completed", self.tool_name),
                            "agentName": "Tool Handler"
                        }
                    }),
                )
                .await;

                Ok(NodeOutput::Continue(None))
            }
            Err(err) => {
                let failure = format!("Tool `{}` failed: {}", self.tool_name, err);

                state.agent_scratchpad.push(crate::llama::ChatMessage {
                    role: "system".to_string(),
                    content: failure.clone(),
                });

                let _ = send_json(
                    ctx.sender,
                    json!({
                        "type": "activity",
                        "data": {
                            "id": "tool_execution",
                            "status": "error",
                            "message": &failure,
                            "agentName": "Tool Handler"
                        }
                    }),
                )
                .await;

                // Continue even on failure (agent will see the error)
                Ok(NodeOutput::Continue(None))
            }
        }
    }
}
