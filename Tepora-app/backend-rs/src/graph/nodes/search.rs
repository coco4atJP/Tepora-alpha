// Search Node
// Web search and RAG context building

use async_trait::async_trait;
use serde_json::json;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llama::ChatMessage;
use crate::tools::search::perform_search;
use crate::tools::vector_math;
use crate::server::ws::handler::send_json;

pub struct SearchNode;

impl SearchNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SearchNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for SearchNode {
    fn id(&self) -> &'static str {
        "search"
    }

    fn name(&self) -> &'static str {
        "Search Node"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        // Check if web search is enabled and not skipped
        let search_enabled = ctx
            .config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !search_enabled || state.skip_web_search {
            tracing::info!(
                "Search skipped: enabled={}, skip={}",
                search_enabled,
                state.skip_web_search
            );
            // Add system message about no search
            state.output = Some("Web search is disabled or skipped.".to_string());
            return Ok(NodeOutput::Final);
        }

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "search",
                    "status": "processing",
                    "message": "Executing web search...",
                    "agentName": "Search"
                }
            }),
        )
        .await;

        // Perform search
        let search_results = match perform_search(ctx.config, &state.input).await {
            Ok(results) => results,
            Err(err) => {
                let _ = send_json(
                    ctx.sender,
                    json!({"type": "status", "message": format!("Search failed: {}", err)}),
                )
                .await;
                return Err(GraphError::new(self.id(), err.to_string()));
            }
        };

        // Rerank results using embeddings if available
        let reranked_results =
            rerank_with_embeddings(ctx.app_state, ctx.config, &state.input, search_results).await;

        // Send search results to client
        let _ = send_json(
            ctx.sender,
            json!({ "type": "search_results", "data": reranked_results }),
        )
        .await;

        state.search_results = Some(reranked_results.clone());

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "search",
                    "status": "done",
                    "message": format!("Found {} results", reranked_results.len()),
                    "agentName": "Search"
                }
            }),
        )
        .await;

        // Generate summary with search context
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "summarize",
                    "status": "processing",
                    "message": "Summarizing results...",
                    "agentName": "Search"
                }
            }),
        )
        .await;

        // Build messages with search context
        let summary = serde_json::to_string_pretty(&reranked_results).unwrap_or_default();
        let mut messages = state.chat_history.clone();

        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!(
                "Web search results (use these as sources and cite as [Source: URL]):\n{}",
                summary
            ),
        });

        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        // Resolve model ID
        let model_id = {
            let registry = ctx
                .app_state
                .models
                .get_registry()
                .map_err(|e| GraphError::new(self.id(), e.to_string()))?;
            registry
                .role_assignments
                .get("character")
                .cloned()
                .unwrap_or_else(|| "default".to_string())
        };

        // Convert messages
        let llm_messages: Vec<crate::llm::types::ChatMessage> = messages
            .into_iter()
            .map(|m| crate::llm::types::ChatMessage {
                role: m.role,
                content: m.content,
            })
            .collect();

        // Build request
        let request = crate::llm::types::ChatRequest::new(llm_messages).with_config(ctx.config);

        // Stream response
        let mut stream = ctx
            .app_state
            .llm
            .stream_chat(request, &model_id)
            .await
            .map_err(|e| GraphError::new(self.id(), e.to_string()))?;

        let mut full_response = String::new();

        while let Some(chunk_result) = stream.recv().await {
            match chunk_result {
                Ok(chunk) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    full_response.push_str(&chunk);
                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "chunk",
                            "message": chunk,
                            "mode": "search",
                        }),
                    )
                    .await;
                }
                Err(err) => {
                    return Err(GraphError::new(self.id(), err.to_string()));
                }
            }
        }

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "summarize",
                    "status": "done",
                    "message": "Summary complete",
                    "agentName": "Search"
                }
            }),
        )
        .await;

        let _ = send_json(ctx.sender, json!({"type": "done"})).await;

        state.output = Some(full_response);
        Ok(NodeOutput::Final)
    }
}

async fn rerank_with_embeddings(
    app_state: &crate::state::AppState,
    config: &serde_json::Value,
    query: &str,
    results: Vec<crate::tools::search::SearchResult>,
) -> Vec<crate::tools::search::SearchResult> {
    let enabled = config
        .get("search")
        .and_then(|v| v.get("embedding_rerank"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    if !enabled || query.trim().is_empty() || results.len() < 2 {
        return results;
    }

    // Resolve embedding model ID
    let model_id = match app_state.models.get_registry() {
        Ok(registry) => registry
            .role_assignments
            .get("embedding")
            .cloned(),
        Err(_) => None,
    };

    let model_id = match model_id {
        Some(id) => id,
        None => return results, // No embedding model assigned
    };

    let mut inputs = Vec::with_capacity(results.len() + 1);
    inputs.push(query.to_string());
    for result in &results {
        inputs.push(format!("{}\n{}", result.title, result.snippet));
    }

    let embeddings = match app_state.llm.embed(&inputs, &model_id).await {
        Ok(vectors) => vectors,
        Err(_) => return results,
    };

    if embeddings.len() != inputs.len() {
        return results;
    }

    let query_embedding = &embeddings[0];
    let candidate_embeddings = embeddings[1..].to_vec();
    let ranking =
        match vector_math::rank_descending_by_cosine(query_embedding, &candidate_embeddings) {
            Ok(scores) => scores,
            Err(_) => return results,
        };

    let mut reranked = Vec::with_capacity(results.len());
    for (idx, _) in ranking {
        if let Some(result) = results.get(idx).cloned() {
            reranked.push(result);
        }
    }

    if reranked.len() == results.len() {
        reranked
    } else {
        results
    }
}
