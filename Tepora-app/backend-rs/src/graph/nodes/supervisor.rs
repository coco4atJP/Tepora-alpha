// Supervisor Node
// Routes agent mode requests based on agent_mode

use async_trait::async_trait;
use serde_json::json;

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

        // Determine route based on agent_mode
        let (route, route_label) = match state.agent_mode {
            AgentMode::High => {
                // Always go through planner
                state.supervisor_route = Some(SupervisorRoute::Planner);
                ("planner", "planner")
            }
            AgentMode::Low => {
                // Low mode: skip planner unless complexity detected
                if requires_planning(&state.input) {
                    state.supervisor_route = Some(SupervisorRoute::Planner);
                    ("planner", "planner")
                } else {
                    state.supervisor_route = Some(SupervisorRoute::Agent(
                        state.agent_id.clone().unwrap_or_default(),
                    ));
                    ("agent_executor", "direct")
                }
            }
            AgentMode::Direct => {
                // Go directly to the specified agent
                let agent_id = state.agent_id.clone().unwrap_or_default();
                state.supervisor_route = Some(SupervisorRoute::Agent(agent_id));
                ("agent_executor", "direct")
            }
        };

        let agent_name = state
            .selected_agent_id
            .clone()
            .unwrap_or_else(|| "Professional Agent".to_string());

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

        tracing::info!(
            "Supervisor: mode={}, routing to {}",
            state.agent_mode.as_str(),
            route
        );

        Ok(NodeOutput::Branch(route.to_string()))
    }
}

/// Determines if planning is required for low mode
fn requires_planning(input: &str) -> bool {
    let lowered = input.to_lowercase();

    // Long inputs likely need planning
    if lowered.len() > 220 {
        return true;
    }

    // Check for complexity indicators
    let indicators = [
        "step by step",
        "plan",
        "roadmap",
        "architecture",
        "migration",
        "strategy",
        "analysis",
        "complex",
        "比較",
        "分析",
        "計画",
        "設計",
        "段階",
        "手順",
        "移行",
        "包括",
        "複雑",
    ];

    indicators.iter().any(|keyword| lowered.contains(keyword))
}
