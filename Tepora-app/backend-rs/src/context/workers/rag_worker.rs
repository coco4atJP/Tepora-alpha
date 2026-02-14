//! RagWorker -- Retrieves relevant chunks from the LanceDB RAG store.
//!
//! Queries the LanceDB-backed `RagStore` for chunks similar to the user's
//! input and adds them to the `PipelineContext` as `RagChunk` entries.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::PipelineContext;
use crate::context::worker::{ContextWorker, WorkerError};
use crate::rag::RagStore;
use crate::state::AppState;

/// Worker that retrieves RAG context from LanceDB.
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
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        // Only execute for modes that support RAG
        if !ctx.mode.has_rag() {
            return Err(WorkerError::skipped("rag", "mode does not use RAG"));
        }

        // Check if there is anything in the RAG store
        let chunk_count = state
            .rag_store
            .count(Some(&ctx.session_id))
            .await
            .unwrap_or(0);

        if chunk_count == 0 {
            return Err(WorkerError::skipped(
                "rag",
                "no RAG chunks in store for this session",
            ));
        }

        // For now, use a simple keyword-based query embedding placeholder.
        // In production, the embedding would be computed via the LLM's
        // embedding model (e.g., EmbeddingGemma).
        //
        // TODO: Integrate with LlmService::embed() once embedding endpoint
        //       is available. For now, we fall back to a text-based
        //       approach by querying with a zero vector (which returns
        //       all chunks sorted by insertion order).
        //
        // Once embedding is available:
        //   let query_embedding = state.llm.embed(&ctx.user_input).await?;
        //   let results = state.rag_store.search(&query_embedding, ...).await?;

        // Attempt vector search — skip if no embedding model is available yet
        // This graceful degradation allows the RAG pipeline to be wired up
        // before the embedding model is fully integrated.
        tracing::debug!(
            "RagWorker: querying LanceDB for session '{}' (limit {})",
            ctx.session_id,
            self.max_chunks
        );

        // For the initial integration we skip if we cannot produce embeddings.
        // The store still accepts pre-computed embeddings via insert_batch.
        Err(WorkerError::skipped(
            "rag",
            "embedding model not yet wired — RAG store is ready, awaiting LlmService::embed()",
        ))
    }
}
