//! MemoryWorker — Retrieves conversation history and long-term memory.
//!
//! Pulls recent chat history from `HistoryStore` and (eventually) EM-LLM
//! memory chunks, then adds them to the `PipelineContext`.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::PipelineContext;
use crate::context::worker::{ContextWorker, WorkerError};
use crate::llama::ChatMessage;
use crate::state::AppState;

/// Worker that loads conversation history and memory into the pipeline.
pub struct MemoryWorker {
    /// Maximum number of history messages to retrieve.
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
        // 1. Load conversation history
        let history_messages = state
            .history
            .get_history(&ctx.session_id, self.history_limit)
            .await
            .map_err(|e| {
                WorkerError::retryable("memory", format!("Failed to load history: {e}"))
            })?;

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

        // 2. Long-term memory (EM-LLM) — placeholder for future integration
        // When EM-LLM is integrated, relevant memory chunks will be retrieved
        // here and added to ctx.memory_chunks.

        Ok(())
    }
}
