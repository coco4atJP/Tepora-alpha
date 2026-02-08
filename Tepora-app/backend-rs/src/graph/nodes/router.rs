// Router Node
// Entry point that routes based on mode

use async_trait::async_trait;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentState, Mode};

pub struct RouterNode;

impl RouterNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RouterNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for RouterNode {
    fn id(&self) -> &'static str {
        "router"
    }

    fn name(&self) -> &'static str {
        "Mode Router"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        _ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let route = match state.mode {
            Mode::Chat => {
                if state.thinking_enabled {
                    "thinking"
                } else {
                    "chat"
                }
            }
            Mode::Search => "search",
            Mode::Agent => "supervisor",
        };

        tracing::info!(
            "Router: mode={}, thinking={}, routing to {}",
            state.mode.as_str(),
            state.thinking_enabled,
            route
        );

        Ok(NodeOutput::Branch(route.to_string()))
    }
}
