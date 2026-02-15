//! MemoryWorker — Retrieves conversation history and long-term memory.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::{MemoryChunk, PipelineContext};
use crate::context::worker::{ContextWorker, WorkerError};
use crate::llm::ChatMessage;
use crate::state::AppState;

pub struct MemoryWorker {
    history_limit: i64,
}

impl MemoryWorker {
    pub fn new(history_limit: i64) -> Self {
        Self { history_limit }
    }
}

impl Default for MemoryWorker {
    fn default() -> Self {
        Self::new(50)
    }
}

#[async_trait]
impl ContextWorker for MemoryWorker {
    fn name(&self) -> &str {
        "memory"
    }

    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        let history_messages = state
            .history
            .get_history(&ctx.session_id, self.history_limit)
            .await
            .map_err(|e| WorkerError::retryable("memory", format!("Failed to load history: {e}")))?;

        let mut chat_messages = Vec::new();
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

        ctx.messages = chat_messages;

        if state.em_memory_service.enabled() && !ctx.user_input.trim().is_empty() {
            let embedding_model_id = state
                .models
                .get_registry()
                .ok()
                .and_then(|registry| {
                    registry
                        .role_assignments
                        .get("embedding")
                        .cloned()
                        .or_else(|| {
                            registry
                                .models
                                .iter()
                                .find(|model| model.role == "embedding")
                                .map(|model| model.id.clone())
                        })
                        .or_else(|| registry.models.first().map(|model| model.id.clone()))
                })
                .unwrap_or_else(|| "default".to_string());

            match state
                .em_memory_service
                .retrieve_for_query(
                    &ctx.session_id,
                    &ctx.user_input,
                    &state.llm,
                    &embedding_model_id,
                )
                .await
            {
                Ok(memories) => {
                    ctx.memory_chunks = memories
                        .into_iter()
                        .map(|memory| MemoryChunk {
                            content: memory.content,
                            relevance_score: memory.relevance_score,
                            source: memory.source,
                        })
                        .collect();
                }
                Err(err) => {
                    tracing::warn!("MemoryWorker: failed to retrieve EM memory: {}", err);
                }
            }
        }

        Ok(())
    }
}
