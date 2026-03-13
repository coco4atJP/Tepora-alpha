//! SystemWorker — Builds the system prompt from the active character config.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::PipelineContext;
use crate::context::prompt::extract_system_prompt;
use crate::context::worker::{ContextWorker, WorkerError};
use crate::state::AppState;

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
        _state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        let config = ctx.config();

        if let Some(system_prompt) =
            extract_system_prompt(&config).filter(|prompt| !prompt.trim().is_empty())
        {
            ctx.add_system_part("base_system", system_prompt, 200);
        }

        let mode_context = match ctx.mode {
            crate::context::pipeline_context::PipelineMode::Chat => {
                "You are in chat mode. Prefer concise, grounded answers and rely on memory cards instead of replaying old transcript turns."
            }
            crate::context::pipeline_context::PipelineMode::SearchFast => {
                "You are in search mode. Use retrieved evidence and memory cards to answer, and avoid relying on raw search dumps."
            }
            crate::context::pipeline_context::PipelineMode::SearchAgentic => {
                "You are in agentic search mode. Keep intermediate reasoning compact and use evidence summaries for synthesis."
            }
            crate::context::pipeline_context::PipelineMode::AgentHigh => {
                "You are a synthesis agent. Prefer artifact summaries and concise working context over raw execution traces."
            }
            crate::context::pipeline_context::PipelineMode::AgentLow => {
                "You are a speed-oriented synthesis agent. Prefer concise memory and task summaries over long transcripts."
            }
            crate::context::pipeline_context::PipelineMode::AgentDirect => {
                "You are an execution agent. Use local context, task state, and selected tools without replaying full chat history."
            }
        };

        ctx.add_system_part("mode_context", mode_context, 150);

        Ok(())
    }
}
