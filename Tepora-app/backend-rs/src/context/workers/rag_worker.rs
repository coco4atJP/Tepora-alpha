//! RagWorker — Retrieves relevant chunks from the RAG store.
//!
//! Queries the RAG store (LanceDB, Phase C) for chunks similar to the user's
//! input and adds them to the `PipelineContext`.  Until Phase C completes,
//! this worker operates as a no-op placeholder.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::PipelineContext;
use crate::context::worker::{ContextWorker, WorkerError};
use crate::state::AppState;

/// Worker that retrieves RAG context.
pub struct RagWorker {
    /// Maximum number of chunks to retrieve.
    max_chunks: usize,
}

impl RagWorker {
    pub fn new(max_chunks: usize) -> Self {
        Self { max_chunks }
    }
}

impl Default for RagWorker {
    fn default() -> Self {
        Self::new(10)
    }
}

#[async_trait]
impl ContextWorker for RagWorker {
    fn name(&self) -> &str {
        "rag"
    }

    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        _state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        // Only execute for modes that support RAG
        if !ctx.mode.has_rag() {
            return Err(WorkerError::skipped("rag", "mode does not use RAG"));
        }

        // Phase C placeholder: LanceDB integration will provide the actual
        // similarity_search here.  For now, check if the AppState will have
        // a RagStore and skip if not available.
        //
        // Once LanceDB is integrated:
        //
        // let rag_store = state.rag_store.as_ref().ok_or_else(|| {
        //     WorkerError::skipped("rag", "RAG store not initialized")
        // })?;
        //
        // let chunks = rag_store
        //     .similarity_search(&ctx.user_input, self.max_chunks)
        //     .await
        //     .map_err(|e| WorkerError::retryable("rag", format!("RAG query failed: {e}")))?;
        //
        // ctx.rag_chunks = chunks;

        let _ = self.max_chunks; // suppress unused warning until Phase C

        Err(WorkerError::skipped(
            "rag",
            "RAG store not yet integrated (Phase C)",
        ))
    }
}
