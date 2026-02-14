//! SearchWorker — Performs web search and injects results into the pipeline.
//!
//! Wraps the existing `tools::search` module and `tools::reranker` into a
//! `ContextWorker`.  Shared setting: WebSearch on/off applies to both
//! SearchMode and AgentMode.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::PipelineContext;
use crate::context::worker::{ContextWorker, WorkerError};
use crate::state::AppState;
use crate::tools::reranker::rerank_search_results_with_embeddings;
use crate::tools::search;

/// Worker that performs web search and injects results.
pub struct SearchWorker {
    /// Whether web search has been explicitly disabled for this turn.
    skip_web_search: bool,
}

impl SearchWorker {
    pub fn new(skip_web_search: bool) -> Self {
        Self { skip_web_search }
    }
}

impl Default for SearchWorker {
    fn default() -> Self {
        Self::new(false)
    }
}

#[async_trait]
impl ContextWorker for SearchWorker {
    fn name(&self) -> &str {
        "search"
    }

    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        // Only execute for modes that support web search
        if !ctx.mode.has_web_search() {
            return Err(WorkerError::skipped("search", "mode does not use search"));
        }

        let config = state.config.load_config().unwrap_or_default();

        // Check global web search setting
        let allow_search = config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !allow_search || self.skip_web_search {
            return Err(WorkerError::skipped(
                "search",
                "web search is disabled or skipped",
            ));
        }

        // Perform the search
        match search::perform_search(&config, &ctx.user_input).await {
            Ok(results) => {
                let reranked =
                    rerank_search_results_with_embeddings(state, &config, &ctx.user_input, results)
                        .await;
                ctx.search_results = reranked;
            }
            Err(err) => {
                tracing::error!("SearchWorker: search failed: {}", err);
                // Non-fatal — continue with RAG-only fallback (§8)
                return Err(WorkerError::skipped(
                    "search",
                    format!("search failed, continuing with RAG: {err}"),
                ));
            }
        }

        Ok(())
    }
}
