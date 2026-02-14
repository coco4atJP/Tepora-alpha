//! SystemWorker — Builds the system prompt from config.
//!
//! Reads `system_prompt` from the application config and injects it as the
//! highest-priority `SystemPart` into the `PipelineContext`.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::PipelineContext;
use crate::context::worker::{ContextWorker, WorkerError};
use crate::state::AppState;

/// Worker that constructs the system prompt.
pub struct SystemWorker;

impl SystemWorker {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemWorker {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ContextWorker for SystemWorker {
    fn name(&self) -> &str {
        "system"
    }

    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        let config = state.config.load_config().unwrap_or_default();

        // Extract the system prompt from config
        let system_prompt = config
            .get("system_prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if !system_prompt.trim().is_empty() {
            ctx.add_system_part("base_system", &system_prompt, 200);
        }

        // Add mode-specific context
        let mode_context = match ctx.mode {
            crate::context::pipeline_context::PipelineMode::Chat => {
                "You are in chat mode. Have a natural conversation with the user."
            }
            crate::context::pipeline_context::PipelineMode::SearchFast => {
                "You are in search mode. Answer the user's question using the provided search results and RAG context."
            }
            crate::context::pipeline_context::PipelineMode::SearchAgentic => {
                "You are in agentic search mode. Perform multi-step research to thoroughly answer the user's question."
            }
            crate::context::pipeline_context::PipelineMode::AgentHigh => {
                "You are a synthesis agent. Coordinate with planning and execution agents to accomplish the user's task."
            }
            crate::context::pipeline_context::PipelineMode::AgentLow => {
                "You are a synthesis agent (speed-optimized). Select and execute the best agent for the user's task."
            }
            crate::context::pipeline_context::PipelineMode::AgentDirect => {
                "You are an execution agent. Directly perform the user's task using the available tools."
            }
        };

        ctx.add_system_part("mode_context", mode_context, 150);

        Ok(())
    }
}
