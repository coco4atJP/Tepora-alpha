// Search Node
// Search Fast flow: web search -> fetch -> rag_ingest -> rag_search -> answer.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::PipelineMode;
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llm::ChatRequest;
use crate::rag::ChunkSearchResult;
use crate::server::ws::handler::send_json;
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

        let mut messages = if let Some(pipeline_ctx) = state.pipeline_context.as_ref() {
            ContextPipeline::pipeline_to_context_result(pipeline_ctx).messages
        } else {
            state.chat_history.clone()
        };

        if let Some(last) = messages.last() {
            if last.role == "user" && last.content.trim() == state.input.trim() {
                messages.pop();
            }
        }

        let search_enabled = ctx
            .config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut web_results = Vec::new();
        let mut web_failed = false;

        if search_enabled && !state.skip_web_search {
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

            match execute_tool(
                Some(ctx.app_state),
                ctx.config,
                Some(&ctx.app_state.mcp),
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
                        let _ = send_json(
                            ctx.sender,
                            json!({ "type": "search_results", "data": web_results }),
                        )
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
                                }
                            }),
                        )
                        .await;
                    }
                }
                Err(err) => {
                    web_failed = true;
                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "status",
                            "message": format!("Web search failed, continuing with RAG only: {}", err),
                        }),
                    )
                    .await;
                }
            }

            let _ = send_json(
                ctx.sender,
                json!({
                    "type": "activity",
                    "data": {
                        "id": "search",
                        "status": "done",
                        "message": "Search and fetch phase complete",
                        "agentName": "Search"
                    }
                }),
            )
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
            Some(&ctx.app_state.mcp),
            Some(&state.session_id),
            "native_rag_search",
            &json!({ "query": state.input, "limit": rag_limit }),
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let rag_chunks: Vec<ChunkSearchResult> = parse_json_payload(&rag_execution.output).unwrap_or_default();

        if rag_chunks.is_empty() {
            let fallback_message = if web_failed {
                "Web search failed and RAG context is empty. Please try again or ingest relevant documents first."
                    .to_string()
            } else {
                "RAG context is empty. I can only answer from existing session knowledge right now."
                    .to_string()
            };

            let _ = send_json(
                ctx.sender,
                json!({
                    "type": "chunk",
                    "message": fallback_message,
                    "mode": "search",
                }),
            )
            .await;
            let _ = send_json(ctx.sender, json!({"type": "done"})).await;
            state.output = Some(
                "RAG context is empty. Please ingest additional sources for higher quality results."
                    .to_string(),
            );
            return Ok(NodeOutput::Final);
        }

        let rag_context = rag_chunks
            .iter()
            .enumerate()
            .map(|(index, item)| {
                format!(
                    "[{}] chunk_id={} source={} score={:.3}\n{}",
                    index + 1,
                    item.chunk.chunk_id,
                    item.chunk.source,
                    item.score,
                    item.chunk.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        messages.push(crate::llm::ChatMessage {
            role: "system".to_string(),
            content: format!(
                "Use the following RAG evidence to answer. Cite using chunk_id/source when relevant:\n{}",
                rag_context
            ),
        });
        messages.push(crate::llm::ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        let model_id = {
            let registry = ctx
                .app_state
                .models
                .get_registry()
                .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            registry
                .role_assignments
                .get("character")
                .cloned()
                .unwrap_or_else(|| "default".to_string())
        };

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

        let _ = send_json(ctx.sender, json!({"type": "done"})).await;

        state.search_results = Some(web_results);
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
