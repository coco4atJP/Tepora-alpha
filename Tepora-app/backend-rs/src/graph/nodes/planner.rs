// Planner Node
// Generates execution plan for complex tasks

use async_trait::async_trait;
use serde_json::json;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llama::ChatMessage;
use crate::ws::send_json;

pub struct PlannerNode;

impl PlannerNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PlannerNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for PlannerNode {
    fn id(&self) -> &'static str {
        "planner"
    }

    fn name(&self) -> &'static str {
        "Planner"
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
                    "id": "generate_order",
                    "status": "processing",
                    "message": "Generating execution plan",
                    "agentName": "Planner"
                }
            }),
        )
        .await;

        let selected_agent = state
            .selected_agent_id
            .clone()
            .unwrap_or_else(|| "default".to_string());

        let detail = if state.thinking_enabled {
            "detailed"
        } else {
            "compact"
        };

        let planning_messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: PLANNING_SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "User request:\n{}\n\nPreferred executor:\n{}\n\nDetail level:\n{}",
                    state.input, selected_agent, detail
                ),
            },
        ];

        let plan = ctx
            .app_state
            .llama
            .chat(ctx.config, planning_messages)
            .await
            .map_err(|e| GraphError::new(self.id(), e.to_string()))?;

        let trimmed = plan.trim();
        let final_plan = if trimmed.is_empty() {
            DEFAULT_PLAN.to_string()
        } else {
            trimmed.to_string()
        };

        // Store plan in shared context
        state.shared_context.current_plan = Some(final_plan.clone());

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "generate_order",
                    "status": "done",
                    "message": "Execution plan generated",
                    "agentName": "Planner"
                }
            }),
        )
        .await;

        tracing::info!("Planner: generated plan with {} chars", final_plan.len());

        // Continue to agent executor
        Ok(NodeOutput::Continue(Some("agent_executor".to_string())))
    }
}

const PLANNING_SYSTEM_PROMPT: &str = r#"You are a planner for a tool-using AI agent.
Create a practical execution plan with up to 6 ordered steps.
Use concise markdown bullets and include fallback actions.
Do not add any text before or after the plan."#;

const DEFAULT_PLAN: &str = r#"- Clarify objective and constraints
- Gather required evidence
- Execute tools safely
- Synthesize final answer"#;
