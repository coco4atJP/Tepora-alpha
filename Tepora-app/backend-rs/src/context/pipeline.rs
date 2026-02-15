use std::sync::Arc;
use serde_json::Value;
use crate::state::AppState;
use crate::llm::ChatMessage;
use crate::core::errors::ApiError;
use super::prompt::{extract_system_prompt, extract_history_limit};
use crate::tools::search::{self, SearchResult};
use crate::tools::reranker::rerank_search_results_with_embeddings;
use super::pipeline_context::{PipelineContext, PipelineMode, TokenBudget};
use super::worker::WorkerPipeline;
use super::workers::system_worker::SystemWorker;
use super::workers::persona_worker::PersonaWorker;
use super::workers::memory_worker::MemoryWorker;
use super::workers::tool_worker::ToolWorker;
use super::workers::search_worker::SearchWorker;
use super::workers::rag_worker::RagWorker;

pub struct ContextResult {
    pub messages: Vec<ChatMessage>,
    pub search_results: Option<Vec<SearchResult>>,
}

pub struct ContextPipeline;

impl ContextPipeline {
    /// Legacy build — retained for backward compatibility.
    ///
    /// Use `build_v4` for new code paths. This method will be
    /// removed once all graph nodes have migrated to WorkerPipeline.
    pub async fn build_chat_context(
        state: &Arc<AppState>,
        config: &Value,
        session_id: &str,
        user_input: &str,
        mode: &str,
        skip_web_search: bool,
    ) -> Result<ContextResult, ApiError> {
        let mut chat_messages = Vec::new();

        // 1. System Prompt
        if let Some(prompt) = extract_system_prompt(config) {
            if !prompt.trim().is_empty() {
                chat_messages.push(ChatMessage {
                    role: "system".to_string(),
                    content: prompt,
                });
            }
        }

        // 2. History
        let history_limit = extract_history_limit(config);
        let history_messages = state
            .history
            .get_history(session_id, history_limit)
            .await?;

        for msg in history_messages {
            let role = match msg.message_type.as_str() {
                "ai" => "assistant",
                "system" => "system",
                "tool" => "assistant",
                _ => "user",
            };
            if msg.content.trim().is_empty() {
                continue;
            }
            chat_messages.push(ChatMessage {
                role: role.to_string(),
                content: msg.content,
            });
        }

        let mut search_results = None;

        // 3. Search Injection (only for search mode)
        if mode == "search" {
            let allow_search = config
                .get("privacy")
                .and_then(|v| v.get("allow_web_search"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if allow_search && !skip_web_search {
                match search::perform_search(config, user_input).await {
                    Ok(results) => {
                        let reranked_results = rerank_search_results_with_embeddings(
                            state,
                            config,
                            user_input,
                            results,
                        )
                        .await;

                        let summary = serde_json::to_string_pretty(&reranked_results).unwrap_or_default();
                        if !summary.is_empty() {
                            chat_messages.push(ChatMessage {
                                role: "system".to_string(),
                                content: format!(
                                    "Web search results (use these as sources and cite as [Source: URL]):\n{}",
                                    summary
                                ),
                            });
                        }
                        search_results = Some(reranked_results);
                    }
                    Err(err) => {
                        tracing::error!("Search failed: {}", err);
                        chat_messages.push(ChatMessage {
                            role: "system".to_string(),
                            content: format!("Web search failed: {}", err),
                        });
                    }
                }
            } else {
                chat_messages.push(ChatMessage {
                    role: "system".to_string(),
                    content: "Web search is disabled or skipped. Answer without external search."
                        .to_string(),
                });
            }
        }

        Ok(ContextResult {
            messages: chat_messages,
            search_results,
        })
    }

    /// v4.0 pipeline — builds context via WorkerPipeline.
    ///
    /// Returns a `PipelineContext` that can be stored in `AgentState`
    /// and converted to chat messages as needed.
    pub async fn build_v4(
        state: &Arc<AppState>,
        session_id: &str,
        user_input: &str,
        mode: PipelineMode,
        skip_web_search: bool,
    ) -> Result<PipelineContext, ApiError> {
        let mut pipeline_ctx = PipelineContext::new(
            session_id,
            uuid::Uuid::new_v4().to_string(),
            mode,
            user_input,
        )
        .with_token_budget(TokenBudget::new(12288, 2048));

        let pipeline = WorkerPipeline::new()
            .add_worker(Box::new(SystemWorker))
            .add_worker(Box::new(PersonaWorker))
            .add_worker(Box::new(MemoryWorker::default()))
            .add_worker(Box::new(ToolWorker))
            .add_worker(Box::new(SearchWorker::new(skip_web_search)))
            .add_worker(Box::new(RagWorker::default()));

        pipeline
            .run(&mut pipeline_ctx, state)
            .await
            .map_err(|e| ApiError::Internal(format!("Pipeline failed: {e}")))?;

        Ok(pipeline_ctx)
    }

    /// Convert a v4 PipelineContext into the legacy ContextResult format.
    ///
    /// This bridges new pipeline output to existing graph nodes.
    pub fn pipeline_to_context_result(ctx: &PipelineContext) -> ContextResult {
        // Use PipelineContext's built-in to_messages() which already handles
        // system parts, persona, memory, RAG, search, and scratchpad.
        let messages = ctx.to_messages();

        // Convert search_results from PipelineContext
        let search_results = if ctx.search_results.is_empty() {
            None
        } else {
            Some(ctx.search_results.clone())
        };

        ContextResult {
            messages,
            search_results,
        }
    }
}
