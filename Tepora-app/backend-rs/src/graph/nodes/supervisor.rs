// Supervisor Node
// Routes agent requests based on agent_mode and selected execution agent.

use async_trait::async_trait;
use serde_json::json;

use crate::agent::execution::choose_agent_from_manager;
use crate::agent::planner::requires_fast_mode_planning;
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentMode, AgentState, SupervisorRoute};
use crate::server::ws::handler::send_json;

pub struct SupervisorNode;

impl SupervisorNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SupervisorNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for SupervisorNode {
    fn id(&self) -> &'static str {
        "supervisor"
    }

    fn name(&self) -> &'static str {
        "Supervisor"
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
                    "id": "supervisor",
                    "status": "processing",
                    "message": "Evaluating request and selecting execution route",
                    "agentName": "Supervisor"
                }
            }),
        )
        .await;

        if matches!(state.agent_mode, AgentMode::Direct) {
            if let Some(requested) = state
                .agent_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let enabled = ctx
                    .app_state
                    .exclusive_agents
                    .get(requested)
                    .map(|agent| agent.enabled)
                    .unwrap_or(false);
                if !enabled {
                    return Err(GraphError::new(
                        self.id(),
                        format!(
                            "Requested agent '{}' is not available or not enabled",
                            requested
                        ),
                    ));
                }
            }
        }

        let selected_agent =
            choose_agent_from_manager(ctx.app_state, state.agent_id.as_deref(), &state.input);
        state.selected_agent_id = selected_agent.as_ref().map(|agent| agent.id.clone());

        let (route, route_label) = match state.agent_mode {
            AgentMode::High => {
                state.supervisor_route = Some(SupervisorRoute::Planner);
                ("planner", "planner")
            }
            AgentMode::Low => {
                if requires_fast_mode_planning(&state.input) {
                    state.supervisor_route = Some(SupervisorRoute::Planner);
                    ("planner", "planner")
                } else {
                    let selected = state.selected_agent_id.clone().unwrap_or_default();
                    state.supervisor_route = Some(SupervisorRoute::Agent(selected));
                    ("agent_executor", "direct")
                }
            }
            AgentMode::Direct => {
                let selected = state.selected_agent_id.clone().unwrap_or_default();
                state.supervisor_route = Some(SupervisorRoute::Agent(selected));
                ("agent_executor", "direct")
            }
        };

        let agent_name = selected_agent
            .as_ref()
            .map(|agent| agent.name.clone())
            .unwrap_or_else(|| "Default Agent".to_string());

        let routing_message = format!(
            "Mode={}, route={}, agent={}",
            state.agent_mode.as_str(),
            route_label,
            agent_name
        );

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "supervisor",
                    "status": "done",
                    "message": routing_message,
                    "agentName": "Supervisor"
                }
            }),
        )
        .await;

        Ok(NodeOutput::Branch(route.to_string()))
    }
}
