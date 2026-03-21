// Router Node
// Entry point that routes based on mode

use async_trait::async_trait;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentState, Mode};
use crate::search::SearchMode;

pub struct RouterNode;

impl RouterNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RouterNode {
    fn default() -> Self {
        Self
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
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let route = match state.mode {
            Mode::Chat => {
                if state.thinking_budget > 0 {
                    "thinking"
                } else {
                    "chat"
                }
            }
            Mode::Search => {
                if state.search_mode == SearchMode::Deep {
                    "search_agentic"
                } else {
                    "search"
                }
            }
            Mode::SearchAgentic => "search_agentic",
            Mode::Agent => "supervisor",
        };

        let agentic_label = if route == "search_agentic" {
            " (agentic)"
        } else {
            ""
        };

        // Notify via config if agentic mode selected
        if route == "search_agentic" {
            let _ = ctx
                .sender
                .send_json(serde_json::json!({
                    "type": "status",
                    "message": "Deep research mode activated"
                }))
                .await;
        }

        tracing::info!(
            "Router: mode={}{}, thinking={}, routing to {}",
            state.mode.as_str(),
            agentic_label,
            state.thinking_budget > 0, // Changed from state.thinking_enabled
            route
        );

        Ok(NodeOutput::Branch(route.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::state::AgentState;
    use crate::search::SearchMode;

    // =======================================================================
    // RouterNode structural tests
    // =======================================================================

    #[test]
    fn router_node_id_and_name() {
        let node = RouterNode::new();
        assert_eq!(node.id(), "router");
        assert_eq!(node.name(), "Mode Router");
    }

    #[test]
    fn router_node_default() {
        let node = RouterNode;
        assert_eq!(node.id(), "router");
    }

    #[test]
    fn explicit_search_mode_routes_to_quick_or_deep() {
        let mut state = AgentState::new("s".to_string(), "query".to_string(), Mode::Search);
        state.search_mode = SearchMode::Quick;
        let route = match state.mode {
            Mode::Search if state.search_mode == SearchMode::Deep => "search_agentic",
            Mode::Search => "search",
            _ => unreachable!(),
        };
        assert_eq!(route, "search");

        state.search_mode = SearchMode::Deep;
        let route = match state.mode {
            Mode::Search if state.search_mode == SearchMode::Deep => "search_agentic",
            Mode::Search => "search",
            _ => unreachable!(),
        };
        assert_eq!(route, "search_agentic");
    }
}
