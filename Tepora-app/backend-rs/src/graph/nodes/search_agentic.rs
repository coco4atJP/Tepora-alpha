// Agentic Search Node
// 4-stage pipeline with RAG-centric retrieval and artifact accumulation.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::PipelineMode;
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentState, Artifact};
use crate::llm::{ChatMessage, ChatRequest};
use crate::rag::{ChunkSearchResult, StoredChunk};
use crate::server::ws::handler::send_json;
use crate::tools::execute_tool;
use crate::tools::search::SearchResult;

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

#[derive(Debug, Clone)]
struct RagArtifactChunk {
    chunk_id: String,
    source: String,
    content: String,
    score: f32,
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
        let should_rebuild = state
            .pipeline_context
            .as_ref()
            .map(|pipeline| pipeline.mode != PipelineMode::SearchAgentic)
            .unwrap_or(true);
        if should_rebuild {
            let app_state = Arc::new(ctx.app_state.clone());
            let pipeline_ctx = ContextPipeline::build_v4(
                &app_state,
                &state.session_id,
                &state.input,
                PipelineMode::SearchAgentic,
                true,
            )
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            state.pipeline_context = Some(pipeline_ctx);
        }

        // Stage 1: Query Generation
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

        // Stage 2: RAG-centric retrieval and chunk window expansion
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_chunk_select",
                    "status": "processing",
                    "message": "Collecting and selecting relevant chunks...",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        let (selected_chunks, display_results) =
            self.search_and_select(state, ctx, &sub_queries).await?;

        state.search_results = Some(display_results.clone());
        let _ = send_json(
            ctx.sender,
            json!({ "type": "search_results", "data": display_results }),
        )
        .await;

        let chunk_ids = selected_chunks
            .iter()
            .map(|chunk| Value::String(chunk.chunk_id.clone()))
            .collect::<Vec<_>>();
        let sources = selected_chunks
            .iter()
            .map(|chunk| Value::String(chunk.source.clone()))
            .collect::<Vec<_>>();

        let artifact_text = selected_chunks
            .iter()
            .enumerate()
            .map(|(index, chunk)| {
                format!(
                    "[{}] chunk_id={} source={} score={:.3}\n{}",
                    index + 1,
                    chunk.chunk_id,
                    chunk.source,
                    chunk.score,
                    chunk.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let mut metadata = HashMap::new();
        metadata.insert("chunk_ids".to_string(), Value::Array(chunk_ids));
        metadata.insert("sources".to_string(), Value::Array(sources));
        metadata.insert(
            "query_count".to_string(),
            Value::Number(serde_json::Number::from(sub_queries.len() as u64)),
        );

        state.shared_context.artifacts.push(Artifact {
            artifact_type: "search_chunks".to_string(),
            content: artifact_text,
            metadata,
        });

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_chunk_select",
                    "status": "done",
                    "message": format!("Selected {} chunks", selected_chunks.len()),
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        // Stage 3: Artifact-based report
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "agentic_report",
                    "status": "processing",
                    "message": "Generating artifact report...",
                    "agentName": "Agentic Search"
                }
            }),
        )
        .await;

        let report = self.generate_report(state, ctx, &selected_chunks).await?;

        state.shared_context.artifacts.push(Artifact {
            artifact_type: "research_report".to_string(),
            content: report.clone(),
            metadata: HashMap::new(),
        });

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

        // Stage 4: Persona-enabled final synthesis
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

        let final_answer = self.synthesize_answer(state, ctx, &report).await?;

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

        let active_character = ctx
            .config
            .get("active_agent_profile")
            .and_then(|v| v.as_str());
        let model_id = ctx
            .app_state
            .models
            .resolve_character_model_id(active_character)
            .ok()
            .flatten()
            .unwrap_or_else(|| "default".to_string());

        let request = ChatRequest::new(messages).with_config(ctx.config);
        let response = ctx
            .app_state
            .llm
            .chat(request, &model_id)
            .await
            .map_err(|err| {
                GraphError::new(self.id(), format!("sub-query generation failed: {err}"))
            })?;

        let parsed = parse_json_payload::<Vec<String>>(&response).unwrap_or_default();
        let mut queries = vec![state.input.clone()];
        for query in parsed {
            let query = query.trim().to_string();
            if !query.is_empty() && !queries.iter().any(|existing| existing == &query) {
                queries.push(query);
            }
        }
        queries.truncate(5);
        Ok(queries)
    }

    async fn search_and_select(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        sub_queries: &[String],
    ) -> Result<(Vec<RagArtifactChunk>, Vec<SearchResult>), GraphError> {
        let mut merged: HashMap<String, RagArtifactChunk> = HashMap::new();

        for query in sub_queries {
            self.merge_similarity_results(state, ctx, query, &mut merged)
                .await?;
            self.merge_text_results(state, ctx, query, &mut merged)
                .await?;
        }

        let search_enabled = ctx
            .config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut web_results = Vec::new();
        if search_enabled && !state.skip_web_search {
            for query in sub_queries.iter().take(3) {
                let search = execute_tool(
                    Some(ctx.app_state),
                    ctx.config,
                    Some(&ctx.app_state.mcp),
                    Some(&state.session_id),
                    "native_search",
                    &json!({ "query": query, "limit": 5 }),
                )
                .await;

                let Ok(search) = search else {
                    continue;
                };

                if let Some(results) = search.search_results {
                    for result in results.iter().take(2) {
                        web_results.push(result.clone());

                        let fetched = execute_tool(
                            Some(ctx.app_state),
                            ctx.config,
                            Some(&ctx.app_state.mcp),
                            Some(&state.session_id),
                            "native_web_fetch",
                            &json!({ "url": result.url }),
                        )
                        .await;

                        let Ok(fetched) = fetched else {
                            continue;
                        };
                        if fetched.output.trim().is_empty() {
                            continue;
                        }

                        let _ = execute_tool(
                            Some(ctx.app_state),
                            ctx.config,
                            Some(&ctx.app_state.mcp),
                            Some(&state.session_id),
                            "native_rag_ingest",
                            &json!({
                                "content": fetched.output,
                                "source": result.url,
                                "metadata": {
                                    "title": result.title,
                                    "snippet": result.snippet,
                                    "query": query,
                                }
                            }),
                        )
                        .await;
                    }
                }
            }
        }

        // Re-run similarity search after potential ingest.
        self.merge_similarity_results(state, ctx, &state.input, &mut merged)
            .await?;

        // Expand top chunk windows for better artifact quality.
        let mut ranked = merged.into_values().collect::<Vec<_>>();
        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for chunk in ranked.iter_mut().take(5) {
            let window = execute_tool(
                Some(ctx.app_state),
                ctx.config,
                Some(&ctx.app_state.mcp),
                Some(&state.session_id),
                "native_rag_get_chunk_window",
                &json!({
                    "chunk_id": chunk.chunk_id,
                    "chars": 1500,
                }),
            )
            .await;

            let Ok(window) = window else {
                continue;
            };
            let Some(window_chunks) = parse_json_payload::<Vec<StoredChunk>>(&window.output) else {
                continue;
            };
            if window_chunks.is_empty() {
                continue;
            }

            let merged_text = window_chunks
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            if !merged_text.trim().is_empty() {
                chunk.content = merged_text;
            }
        }

        let display_results = ranked
            .iter()
            .take(15)
            .map(|chunk| SearchResult {
                title: format!("RAG Chunk {}", chunk.chunk_id),
                url: chunk.source.clone(),
                snippet: truncate_text(&chunk.content, 240),
            })
            .collect::<Vec<_>>();

        Ok((ranked, dedupe_search_results(web_results, display_results)))
    }

    async fn merge_similarity_results(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
        query: &str,
        merged: &mut HashMap<String, RagArtifactChunk>,
    ) -> Result<(), GraphError> {
        let result = execute_tool(
            Some(ctx.app_state),
            ctx.config,
            Some(&ctx.app_state.mcp),
            Some(&state.session_id),
            "native_rag_search",
            &json!({ "query": query, "limit": 12 }),
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let Some(chunks) = parse_json_payload::<Vec<ChunkSearchResult>>(&result.output) else {
            return Ok(());
        };

        for item in chunks {
            let entry = merged
                .entry(item.chunk.chunk_id.clone())
                .or_insert_with(|| RagArtifactChunk {
                    chunk_id: item.chunk.chunk_id.clone(),
                    source: item.chunk.source.clone(),
                    content: item.chunk.content.clone(),
                    score: item.score,
                });

            if item.score > entry.score {
                entry.score = item.score;
                entry.source = item.chunk.source;
                entry.content = item.chunk.content;
            }
        }

        Ok(())
    }

    async fn merge_text_results(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
        query: &str,
        merged: &mut HashMap<String, RagArtifactChunk>,
    ) -> Result<(), GraphError> {
        let result = execute_tool(
            Some(ctx.app_state),
            ctx.config,
            Some(&ctx.app_state.mcp),
            Some(&state.session_id),
            "native_rag_text_search",
            &json!({ "pattern": query, "limit": 12 }),
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let Some(chunks) = parse_json_payload::<Vec<StoredChunk>>(&result.output) else {
            return Ok(());
        };

        for chunk in chunks {
            merged
                .entry(chunk.chunk_id.clone())
                .or_insert_with(|| RagArtifactChunk {
                    chunk_id: chunk.chunk_id,
                    source: chunk.source,
                    content: chunk.content,
                    score: 0.45,
                });
        }

        Ok(())
    }

    async fn generate_report(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        chunks: &[RagArtifactChunk],
    ) -> Result<String, GraphError> {
        if chunks.is_empty() {
            return Ok("No RAG chunks available for report generation.".to_string());
        }

        let sources = chunks
            .iter()
            .take(20)
            .enumerate()
            .map(|(index, chunk)| {
                format!(
                    "[{}] chunk_id={} source={} score={:.3}\n{}",
                    index + 1,
                    chunk.chunk_id,
                    chunk.source,
                    chunk.score,
                    chunk.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: concat!(
                    "You are a research analyst. ",
                    "Generate a concise, evidence-grounded report from chunk artifacts.\n",
                    "1. Summarize key findings\n",
                    "2. Note uncertainties or conflicts\n",
                    "3. Reference chunk IDs as [chunk_id]\n",
                    "4. Use the user's language"
                )
                .to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!("Question: {}\n\nArtifacts:\n{}", state.input, sources),
            },
        ];

        let active_character = ctx
            .config
            .get("active_agent_profile")
            .and_then(|v| v.as_str());
        let model_id = ctx
            .app_state
            .models
            .resolve_character_model_id(active_character)
            .ok()
            .flatten()
            .unwrap_or_else(|| "default".to_string());

        let request = ChatRequest::new(messages).with_config(ctx.config);
        ctx.app_state
            .llm
            .chat(request, &model_id)
            .await
            .map_err(|err| GraphError::new(self.id(), format!("report generation failed: {err}")))
    }

    async fn synthesize_answer(
        &self,
        state: &AgentState,
        ctx: &mut NodeContext<'_>,
        report: &str,
    ) -> Result<String, GraphError> {
        // Stage4 is persona-enabled by switching to SearchFast pipeline context.
        let app_state = Arc::new(ctx.app_state.clone());
        let stage4_ctx = ContextPipeline::build_v4(
            &app_state,
            &state.session_id,
            &state.input,
            PipelineMode::SearchFast,
            true,
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let mut messages = ContextPipeline::pipeline_to_context_result(&stage4_ctx).messages;
        if let Some(last) = messages.last() {
            if last.role == "user" && last.content.trim() == state.input.trim() {
                messages.pop();
            }
        }

        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!(
                concat!(
                    "You have completed deep research. ",
                    "Use the report below to provide the final user-facing answer.\n",
                    "Keep citations tied to chunk IDs or source URLs when possible.\n\n",
                    "Research report:\n{}"
                ),
                report
            ),
        });
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        let active_character = ctx
            .config
            .get("active_agent_profile")
            .and_then(|v| v.as_str());
        let model_id = ctx
            .app_state
            .models
            .resolve_character_model_id(active_character)
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?
            .unwrap_or_else(|| "default".to_string());

        let request = ChatRequest::new(messages).with_config(ctx.config);
        let mut stream = ctx
            .app_state
            .llm
            .stream_chat(request, &model_id)
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

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

fn parse_json_payload<T>(output: &str) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    if let Ok(parsed) = serde_json::from_str::<T>(output) {
        return Some(parsed);
    }

    let trimmed = output.trim();
    let start = trimmed.find(['[', '{'])?;
    let end = trimmed.rfind([']', '}'])?;
    if end < start {
        return None;
    }

    serde_json::from_str::<T>(&trimmed[start..=end]).ok()
}

fn truncate_text(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }
    let mut out = text.chars().take(max_len).collect::<String>();
    out.push_str("...");
    out
}

fn dedupe_search_results(
    mut web_results: Vec<SearchResult>,
    mut rag_results: Vec<SearchResult>,
) -> Vec<SearchResult> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();

    for item in web_results.drain(..) {
        if seen.insert(item.url.clone()) {
            out.push(item);
        }
    }

    for item in rag_results.drain(..) {
        if seen.insert(item.url.clone()) {
            out.push(item);
        }
    }

    out
}
