// Planner Node
// Generates execution plan for complex agent tasks.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::execution::{build_agent_chat_config, resolve_selected_agent};
use crate::agent::planner::generate_execution_plan;
use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::PipelineMode;
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentMode, AgentState};
use crate::server::ws::handler::send_json;

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

        let pipeline_mode = match state.agent_mode {
            AgentMode::High => PipelineMode::AgentHigh,
            AgentMode::Low => PipelineMode::AgentLow,
            AgentMode::Direct => PipelineMode::AgentDirect,
        };

        let should_rebuild = state
            .pipeline_context
            .as_ref()
            .map(|pipeline| pipeline.mode != pipeline_mode)
            .unwrap_or(true);
        if should_rebuild {
            let app_state = Arc::new(ctx.app_state.clone());
            let pipeline_ctx = ContextPipeline::build_v4(
                &app_state,
                &state.session_id,
                &state.input,
                pipeline_mode,
                state.skip_web_search,
            )
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            state.pipeline_context = Some(pipeline_ctx);
        }

        let selected_agent =
            resolve_selected_agent(ctx.app_state, state.selected_agent_id.as_deref());
        let agent_chat_config =
            build_agent_chat_config(ctx.app_state, ctx.config, selected_agent.as_ref());
        let plan = generate_execution_plan(
            ctx.app_state,
            &agent_chat_config,
            &state.input,
            selected_agent.as_ref(),
            state.thinking_enabled,
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        state.shared_context.current_plan = Some(plan);

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

        Ok(NodeOutput::Continue(Some("agent_executor".to_string())))
    }
}
