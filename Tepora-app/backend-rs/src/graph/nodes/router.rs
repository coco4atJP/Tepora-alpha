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
                if !state.search_attachments.is_empty() || is_complex_search_query(&state.input) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let node = RouterNode::default();
        assert_eq!(node.id(), "router");
    }

    // =======================================================================
    // is_complex_search_query tests
    // =======================================================================

    #[test]
    fn simple_queries_are_not_complex() {
        assert!(!is_complex_search_query("weather today"));
        assert!(!is_complex_search_query("rust programming"));
        assert!(!is_complex_search_query("how to cook pasta"));
        assert!(!is_complex_search_query(""));
    }

    #[test]
    fn english_depth_keywords_trigger_complex() {
        assert!(is_complex_search_query("compare Rust and Go"));
        assert!(is_complex_search_query(
            "detailed analysis of market trends"
        ));
        assert!(is_complex_search_query(
            "comprehensive guide to microservices"
        ));
        assert!(is_complex_search_query(
            "in-depth review of Tauri framework"
        ));
        assert!(is_complex_search_query("research on episodic memory in AI"));
        assert!(is_complex_search_query("investigate the root cause"));
    }

    #[test]
    fn japanese_depth_keywords_trigger_complex() {
        assert!(is_complex_search_query("RustとGoの比較"));
        assert!(is_complex_search_query("マーケットトレンドの分析"));
        assert!(is_complex_search_query("詳細なレビュー"));
        assert!(is_complex_search_query("AIに関する調査"));
        assert!(is_complex_search_query("包括的なガイド"));
        assert!(is_complex_search_query("深掘りして教えて"));
        assert!(is_complex_search_query("最近のニュースまとめ"));
    }

    #[test]
    fn long_queries_are_complex() {
        // 201 characters
        let long_query = "a".repeat(201);
        assert!(is_complex_search_query(&long_query));
    }

    #[test]
    fn exactly_200_chars_is_not_complex() {
        // Exactly 200 characters (no keywords)
        let query = "a".repeat(200);
        assert!(!is_complex_search_query(&query));
    }

    #[test]
    fn keywords_are_case_insensitive() {
        assert!(is_complex_search_query("COMPARE these two options"));
        assert!(is_complex_search_query("Detailed Analysis"));
        assert!(is_complex_search_query("COMPREHENSIVE overview"));
    }
}
