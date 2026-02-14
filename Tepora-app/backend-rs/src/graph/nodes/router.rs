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
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let route = match state.mode {
            Mode::Chat => {
                if state.thinking_enabled {
                    "thinking"
                } else {
                    "chat"
                }
            }
            Mode::Search => {
                // Agentic search: when attachments are provided or
                // the query appears complex enough for deep research
                if !state.search_attachments.is_empty()
                    || is_complex_search_query(&state.input)
                {
                    "search_agentic"
                } else {
                    "search"
                }
            }
            Mode::Agent => "supervisor",
        };

        let agentic_label = if route == "search_agentic" {
            " (agentic)"
        } else {
            ""
        };

        // Notify via config if agentic mode selected
        if route == "search_agentic" {
            let _ = crate::server::ws::handler::send_json(
                ctx.sender,
                serde_json::json!({
                    "type": "status",
                    "message": "Deep research mode activated"
                }),
            )
            .await;
        }

        tracing::info!(
            "Router: mode={}{}, thinking={}, routing to {}",
            state.mode.as_str(),
            agentic_label,
            state.thinking_enabled,
            route
        );

        Ok(NodeOutput::Branch(route.to_string()))
    }
}

/// Heuristic: determine if a search query warrants deep (agentic) search.
fn is_complex_search_query(input: &str) -> bool {
    let lowered = input.to_lowercase();
    let len = lowered.len();

    // Very long queries likely need deep research
    if len > 200 {
        return true;
    }

    // Keywords indicating research depth
    let depth_indicators = [
        "compare",
        "analysis",
        "comprehensive",
        "in-depth",
        "detailed",
        "research",
        "investigate",
        "比較",
        "分析",
        "詳細",
        "調査",
        "包括的",
        "深掘り",
        "まとめ",
    ];

    depth_indicators
        .iter()
        .any(|keyword| lowered.contains(keyword))
}
