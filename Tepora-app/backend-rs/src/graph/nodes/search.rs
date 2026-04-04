// Search Node
// Search Fast flow: web search -> fetch -> rag_ingest -> rag_search -> answer.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::{PipelineMode, RagChunk};
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llm::{ChatMessage, ChatRequest};
use crate::rag::ChunkSearchResult;
use crate::search::{EvidenceClaim, EvidenceGap, SearchEvidenceState, SearchMode};
use crate::tools::execute_tool;

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
        let should_rebuild = state
            .pipeline_context
            .as_ref()
            .map(|pipeline| pipeline.mode != PipelineMode::SearchFast)
            .unwrap_or(true);
        if should_rebuild {
            let app_state = Arc::new(ctx.app_state.clone());
            let pipeline_ctx = ContextPipeline::build_v4(
                &app_state,
                &state.session_id,
                &state.input,
                PipelineMode::SearchFast,
                true,
            )
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            state.pipeline_context = Some(pipeline_ctx);
        }

        let search_enabled = ctx
            .config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let isolation = ctx
            .config
            .get("privacy")
            .and_then(|v| v.get("isolation_mode"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut web_results = Vec::new();
        let mut web_failed = false;

        if search_enabled && !state.skip_web_search && !isolation {
            let _ = ctx
                .sender
                .send_json(json!({
                    "type": "activity",
                    "data": {
                        "id": "search",
                        "status": "processing",
                        "message": "Executing web search...",
                        "agentName": "Search"
                    }
                }))
                .await;

            match execute_tool(
                Some(ctx.app_state),
                ctx.config,
                Some(&ctx.app_state.integration.mcp),
                Some(&state.session_id),
                "native_search",
                &json!({ "query": state.input, "limit": 8 }),
            )
            .await
            {
                Ok(result) => {
                    if let Some(results) = result.search_results {
                        web_results = results;
                    }

                    if !web_results.is_empty() {
                        let _ = ctx
                            .sender
                            .send_json(json!({ "type": "search_results", "data": web_results }))
                            .await;
                    }

                    let fetch_top_n = ctx
                        .config
                        .get("search")
                        .and_then(|v| v.get("fetch_top_n"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(3)
                        .clamp(1, 8) as usize;

                    for result in web_results.iter().take(fetch_top_n) {
                        let fetched = execute_tool(
                            Some(ctx.app_state),
                            ctx.config,
                            Some(&ctx.app_state.integration.mcp),
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
                            Some(&ctx.app_state.integration.mcp),
                            Some(&state.session_id),
                            "native_rag_ingest",
                            &json!({
                                "content": fetched.output,
                                "source": result.url,
                                "metadata": {
                                    "title": result.title,
                                    "snippet": result.snippet,
                                }
                            }),
                        )
                        .await;
                    }
                }
                Err(err) => {
                    web_failed = true;
                    let _ = ctx.sender.send_json(
                        json!({
                            "type": "status",
                            "message": format!("Web search failed, continuing with RAG only: {}", err),
                        }),
                    )
                    .await;
                }
            }

            let _ = ctx
                .sender
                .send_json(json!({
                    "type": "activity",
                    "data": {
                        "id": "search",
                        "status": "done",
                        "message": "Search and fetch phase complete",
                        "agentName": "Search"
                    }
                }))
                .await;
        }

        let rag_limit = ctx
            .config
            .get("search")
            .and_then(|v| v.get("rag_limit"))
            .and_then(|v| v.as_u64())
            .unwrap_or(8)
            .clamp(1, 20) as usize;

        let rag_execution = execute_tool(
            Some(ctx.app_state),
            ctx.config,
            Some(&ctx.app_state.integration.mcp),
            Some(&state.session_id),
            "native_rag_search",
            &json!({ "query": state.input, "limit": rag_limit }),
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let rag_chunks: Vec<ChunkSearchResult> =
            parse_json_payload(&rag_execution.output).unwrap_or_default();

        if rag_chunks.is_empty() {
            let fallback_message = if web_failed {
                "Web search failed and RAG context is empty. Please try again or ingest relevant documents first."
                    .to_string()
            } else {
                "RAG context is empty. I can only answer from existing session knowledge right now."
                    .to_string()
            };
            state.search_evidence = SearchEvidenceState {
                strategy: SearchMode::Quick,
                query_plan: vec![state.input.clone()],
                explored_sources: build_explored_sources(
                    &state.search_attachments,
                    search_enabled && !state.skip_web_search && !isolation,
                ),
                results: web_results.clone(),
                claims: Vec::new(),
                gaps: vec![EvidenceGap {
                    topic: state.input.clone(),
                    reason: fallback_message.clone(),
                }],
            };

            let _ = ctx
                .sender
                .send_json(json!({
                    "type": "chunk",
                    "message": fallback_message,
                    "mode": "search",
                }))
                .await;
            let _ = ctx.sender.send_json(json!({"type": "done"})).await;
            state.output = Some(
                "RAG context is empty. Please ingest additional sources for higher quality results."
                    .to_string(),
            );
            return Ok(NodeOutput::Final);
        }

        if let Some(pipeline_ctx) = state.pipeline_context.as_mut() {
            pipeline_ctx.search_results = web_results.clone();
            pipeline_ctx.rag_chunks = rag_chunks
                .iter()
                .map(|item| RagChunk {
                    chunk_id: item.chunk.chunk_id.clone(),
                    content: item.chunk.content.clone(),
                    source: item.chunk.source.clone(),
                    score: item.score,
                    metadata: match item.chunk.metadata.clone() {
                        Some(serde_json::Value::Object(map)) => {
                            map.into_iter().collect::<HashMap<_, _>>()
                        }
                        _ => HashMap::new(),
                    },
                })
                .collect();
            pipeline_ctx.reasoning.app_thinking_digest = state.thought_process.clone();
            pipeline_ctx.user_input = state.input.clone();
        }

        let mut messages = if let Some(pipeline_ctx) = state.pipeline_context.as_ref() {
            ContextPipeline::pipeline_to_context_result(pipeline_ctx).messages
        } else {
            state.chat_history.clone()
        };

        // 画像添付がある場合、最後のuserメッセージをマルチモーダルに差し替える
        if !state.image_attachments.is_empty() {
            let images: Vec<_> = state
                .image_attachments
                .iter()
                .map(|a| a.to_image_data())
                .collect();
            if let Some(last_user) = messages.iter_mut().rev().find(|m| m.role == "user") {
                let text = last_user.content.clone();
                *last_user = ChatMessage::new_multimodal("user", &text, &images);
            }
        }

        let request = ChatRequest::new(messages).with_config(ctx.config);

        let active_character = ctx
            .config
            .get("active_character")
            .or_else(|| ctx.config.get("active_agent_profile"))
            .and_then(|v| v.as_str());
        let model_id = ctx
            .app_state
            .ai()
            .models
            .resolve_character_model_id(active_character)
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?
            .unwrap_or_else(|| "default".to_string());

        let mut stream = ctx
            .app_state
            .ai()
            .llm
            .stream_chat_normalized(request, &model_id)
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let mut full_response = String::new();
        while let Some(chunk_result) = stream.recv().await {
            match chunk_result {
                Ok(chunk) => {
                    if !chunk.model_thinking.is_empty() {
                        let _ = ctx
                            .sender
                            .send_json(json!({
                                "type": "thought",
                                "content": chunk.model_thinking,
                                "mode": "search",
                            }))
                            .await;
                    }
                    if chunk.visible_text.is_empty() {
                        continue;
                    }
                    full_response.push_str(&chunk.visible_text);
                    let _ = ctx
                        .sender
                        .send_json(json!({
                            "type": "chunk",
                            "message": chunk.visible_text,
                            "mode": "search",
                        }))
                        .await;
                }
                Err(err) => {
                    return Err(GraphError::new(self.id(), err.to_string()));
                }
            }
        }

        let _ = ctx.sender.send_json(json!({"type": "done"})).await;

        state.search_results = Some(web_results);
        state.search_evidence = SearchEvidenceState {
            strategy: SearchMode::Quick,
            query_plan: vec![state.input.clone()],
            explored_sources: build_explored_sources(
                &state.search_attachments,
                search_enabled && !state.skip_web_search && !isolation,
            ),
            results: state.search_results.clone().unwrap_or_default(),
            claims: rag_chunks
                .iter()
                .take(4)
                .map(|item| EvidenceClaim {
                    topic: item.chunk.source.clone(),
                    summary: truncate_text(first_meaningful_line(&item.chunk.content), 180),
                    citations: vec![item.chunk.chunk_id.clone(), item.chunk.source.clone()],
                    confidence: item.score,
                })
                .collect(),
            gaps: Vec::new(),
        };
        state.output = Some(full_response);
        Ok(NodeOutput::Final)
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

fn first_meaningful_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

fn truncate_text(text: String, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text;
    }
    let mut out = text.chars().take(max_len).collect::<String>();
    out.push_str("...");
    out
}

fn build_explored_sources(attachments: &[serde_json::Value], web_enabled: bool) -> Vec<String> {
    let mut sources = vec!["session_rag".to_string(), "local_knowledge".to_string()];
    if !attachments.is_empty() {
        sources.insert(0, "attachments".to_string());
    }
    if web_enabled {
        sources.push("web".to_string());
    }
    sources
}
