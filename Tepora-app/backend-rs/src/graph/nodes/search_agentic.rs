// Agentic Search Node
// 4-stage deep search pipeline: Query Generate → Chunk Select → Report → Synthesize
//
// Provides a multi-step search workflow that generates sub-queries,
// evaluates and selects the best chunks from search + RAG results,
// writes an intermediate research report, then synthesizes the final answer.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llama::ChatMessage;
use crate::server::ws::handler::send_json;
use crate::tools::search::{perform_search, SearchResult};
use crate::tools::vector_math;

pub struct AgenticSearchNode;

impl AgenticSearchNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AgenticSearchNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for AgenticSearchNode {
    fn id(&self) -> &'static str {
        "search_agentic"
    }

    fn name(&self) -> &'static str {
        "Agentic Search"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        // ═══════════════════════════════════════════════════════════════════
        // Stage 1: Query Generation
        // ═══════════════════════════════════════════════════════════════════
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_query_gen",
                    "status": "processing",
                    "message": "Generating search sub-queries...",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        let sub_queries = self.generate_sub_queries(state, ctx).await?;
        state.search_queries = sub_queries.clone();

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_query_gen",
                    "status": "done",
                    "message": format!("Generated {} sub-queries", sub_queries.len()),
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        // ═══════════════════════════════════════════════════════════════════
        // Stage 2: Parallel Search + Chunk Selection
        // ═══════════════════════════════════════════════════════════════════
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_chunk_select",
                    "status": "processing",
                    "message": "Searching and selecting relevant chunks...",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        let all_results = self
            .search_and_select(state, ctx, &sub_queries)
            .await?;

        // Store the selected chunks as an artifact in shared context
        let chunk_summary = all_results
            .iter()
            .enumerate()
            .map(|(i, r)| format!("[{}] {} — {}", i + 1, r.title, r.snippet))
            .collect::<Vec<_>>()
            .join("\n");

        state.shared_context.artifacts.push(
            crate::graph::state::Artifact {
                artifact_type: "search_chunks".to_string(),
                content: chunk_summary,
                metadata: serde_json::Map::new().into_iter().collect(),
            },
        );

        state.search_results = Some(all_results.clone());

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "search_results",
                "data": &all_results
            }),
        )
        .await;

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_chunk_select",
                    "status": "done",
                    "message": format!("Selected {} relevant chunks", all_results.len()),
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        // ═══════════════════════════════════════════════════════════════════
        // Stage 3: Research Report Generation
        // ═══════════════════════════════════════════════════════════════════
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_report",
                    "status": "processing",
                    "message": "Generating research report...",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        let report = self
            .generate_report(state, ctx, &all_results)
            .await?;

        state.shared_context.artifacts.push(
            crate::graph::state::Artifact {
                artifact_type: "research_report".to_string(),
                content: report.clone(),
                metadata: serde_json::Map::new().into_iter().collect(),
            },
        );

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_report",
                    "status": "done",
                    "message": "Research report complete",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        // ═══════════════════════════════════════════════════════════════════
        // Stage 4: Final Synthesis (streamed)
        // ═══════════════════════════════════════════════════════════════════
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_synthesize",
                    "status": "processing",
                    "message": "Synthesizing final answer...",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        let final_answer = self
            .synthesize_answer(state, ctx, &report)
            .await?;

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_synthesize",
                    "status": "done",
                    "message": "Answer synthesized",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        let _ = send_json(ctx.sender, json!({"type": "done"})).await;

        state.output = Some(final_answer);
        Ok(NodeOutput::Final)
    }
}

impl AgenticSearchNode {
    /// Stage 1: Use LLM to decompose the user query into multiple sub-queries.
    async fn generate_sub_queries(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<Vec<String>, GraphError> {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: concat!(
                    "You are a search query decomposition expert. ",
                    "Given a user question, generate 2-4 focused search sub-queries ",
                    "that together cover all aspects of the question.\n",
                    "Return ONLY a JSON array of strings, e.g. [\"query1\", \"query2\"].\n",
                    "Do not include any text outside the JSON array."
                )
                .to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: state.input.clone(),
            },
        ];

        let response = ctx
            .app_state
            .llama
            .chat(ctx.config, messages)
            .await
            .map_err(|e| GraphError::new(self.id(), format!("Sub-query generation failed: {e}")))?;

        // Parse JSON array from response
        let queries = parse_string_array(&response).unwrap_or_else(|| {
            // Fallback: use original query + a rephrased version
            vec![state.input.clone()]
        });

        // Always include original query
        let mut result = vec![state.input.clone()];
        for q in queries {
            let trimmed = q.trim().to_string();
            if !trimmed.is_empty() && trimmed != state.input {
                result.push(trimmed);
            }
        }

        // Cap at 5 sub-queries
        result.truncate(5);
        Ok(result)
    }

    /// Stage 2: Execute searches for all sub-queries, deduplicate and rerank.
    async fn search_and_select(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        sub_queries: &[String],
    ) -> Result<Vec<SearchResult>, GraphError> {
        let search_enabled = ctx
            .config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !search_enabled || state.skip_web_search {
            return Ok(Vec::new());
        }

        let mut all_results: Vec<SearchResult> = Vec::new();
        let mut seen_urls = std::collections::HashSet::new();

        for query in sub_queries {
            match perform_search(ctx.config, query).await {
                Ok(results) => {
                    for result in results {
                        if seen_urls.insert(result.url.clone()) {
                            all_results.push(result);
                        }
                    }
                }
                Err(err) => {
                    tracing::warn!("Agentic search sub-query '{}' failed: {}", query, err);
                }
            }
        }

        // Rerank all results against the original query
        let reranked = self
            .rerank_results(ctx, &state.input, all_results)
            .await;

        // Keep top results (max 15)
        let limit = 15.min(reranked.len());
        Ok(reranked[..limit].to_vec())
    }

    /// Rerank search results using embedding similarity.
    async fn rerank_results(
        &self,
        ctx: &NodeContext<'_>,
        query: &str,
        results: Vec<SearchResult>,
    ) -> Vec<SearchResult> {
        if results.len() < 2 || query.trim().is_empty() {
            return results;
        }

        let model_id = match ctx.app_state.models.get_registry() {
            Ok(registry) => registry.role_assignments.get("embedding").cloned(),
            Err(_) => None,
        };

        let model_id = match model_id {
            Some(id) => id,
            None => return results,
        };

        let mut inputs = Vec::with_capacity(results.len() + 1);
        inputs.push(query.to_string());
        for result in &results {
            inputs.push(format!("{}\n{}", result.title, result.snippet));
        }

        let embeddings = match ctx.app_state.llm.embed(&inputs, &model_id).await {
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

    /// Stage 3: Generate an intermediate research report from the chunks.
    async fn generate_report(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        results: &[SearchResult],
    ) -> Result<String, GraphError> {
        if results.is_empty() {
            return Ok("No search results available for report generation.".to_string());
        }

        let sources = results
            .iter()
            .enumerate()
            .map(|(i, r)| format!("[{}] Title: {}\nURL: {}\nSnippet: {}", i + 1, r.title, r.url, r.snippet))
            .collect::<Vec<_>>()
            .join("\n\n");

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: concat!(
                    "You are a research analyst. Given the user's question and a set of ",
                    "web search results, write a concise research report that:\n",
                    "1. Identifies the key facts and insights from the sources\n",
                    "2. Notes any contradictions or gaps in the information\n",
                    "3. Cites sources using [N] notation\n",
                    "4. Is structured with clear sections\n",
                    "Write the report in the same language as the user's question."
                )
                .to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "Question: {}\n\nSources:\n{}",
                    state.input, sources
                ),
            },
        ];

        ctx.app_state
            .llama
            .chat(ctx.config, messages)
            .await
            .map_err(|e| GraphError::new(self.id(), format!("Report generation failed: {e}")))
    }

    /// Stage 4: Synthesize the final streamed answer from the report.
    async fn synthesize_answer(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        report: &str,
    ) -> Result<String, GraphError> {
        let search_context = if let Some(results) = &state.search_results {
            let urls: Vec<String> = results
                .iter()
                .take(10)
                .map(|r| format!("- [{}]({})", r.title, r.url))
                .collect();
            format!("\n\nSources:\n{}", urls.join("\n"))
        } else {
            String::new()
        };

        let mut messages = state.chat_history.clone();
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!(
                concat!(
                    "You have conducted deep research on the user's question. ",
                    "Below is your research report. Use it to provide a comprehensive, ",
                    "well-cited answer. Cite sources as [Source: URL] where appropriate.\n\n",
                    "Research Report:\n{}\n{}",
                ),
                report, search_context
            ),
        });
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        // Resolve model
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

        let llm_messages: Vec<crate::llm::types::ChatMessage> = messages
            .into_iter()
            .map(|m| crate::llm::types::ChatMessage {
                role: m.role,
                content: m.content,
            })
            .collect();

        let request = crate::llm::types::ChatRequest::new(llm_messages).with_config(ctx.config);

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

        Ok(full_response)
    }
}

/// Parse a JSON array of strings from LLM output.
fn parse_string_array(text: &str) -> Option<Vec<String>> {
    let trimmed = text.trim();

    // Try direct parse
    if let Ok(arr) = serde_json::from_str::<Vec<String>>(trimmed) {
        return Some(arr);
    }

    // Try extracting JSON array from text
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(&trimmed[start..=end]) {
                return Some(arr);
            }
            // Try parsing as Value array (handles mixed types)
            if let Ok(val) = serde_json::from_str::<Value>(&trimmed[start..=end]) {
                if let Some(arr) = val.as_array() {
                    let strings: Vec<String> = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                    if !strings.is_empty() {
                        return Some(strings);
                    }
                }
            }
        }
    }

    None
}
