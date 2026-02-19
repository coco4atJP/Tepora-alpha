//! RagWorker — Retrieves relevant chunks from the RAG store.
//!
//! Queries the RAG store for chunks similar to the user's input and adds them
//! to the `PipelineContext`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::context::pipeline_context::{PipelineContext, RagChunk};
use crate::context::worker::{ContextWorker, WorkerError};
use crate::models::types::ModelRuntimeConfig;
use crate::state::AppState;

pub struct RagWorker {
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
        if !ctx.mode.has_rag() {
            return Err(WorkerError::skipped("rag", "mode does not use RAG"));
        }

        let query = ctx.user_input.trim();
        if query.is_empty() {
            return Err(WorkerError::skipped("rag", "empty user input"));
        }

        let config = state.config.load_config().unwrap_or_default();
        let model_cfg = ModelRuntimeConfig::for_embedding(&config)
            .map_err(|e| WorkerError::failed("rag", format!("config error: {e}")))?;

        let embeddings = state
            .llama
            .embed(
                &model_cfg,
                &[query.to_string()],
                std::time::Duration::from_secs(5),
            )
            .await
            .map_err(|err| WorkerError::skipped("rag", format!("embedding unavailable: {err}")))?;

        let Some(query_embedding) = embeddings.first() else {
            return Err(WorkerError::skipped("rag", "embedding response was empty"));
        };

        let results = state
            .rag_store
            .search(query_embedding, self.max_chunks, Some(&ctx.session_id))
            .await
            .map_err(|e| WorkerError::retryable("rag", format!("RAG query failed: {e}")))?;

        ctx.rag_chunks = results
            .into_iter()
            .map(|result| RagChunk {
                chunk_id: result.chunk.chunk_id,
                content: result.chunk.content,
                source: result.chunk.source,
                score: result.score,
                metadata: metadata_to_map(result.chunk.metadata),
            })
            .collect();

        Ok(())
    }
}

fn metadata_to_map(metadata: Option<Value>) -> HashMap<String, Value> {
    match metadata {
        Some(Value::Object(map)) => map.into_iter().collect(),
        _ => HashMap::new(),
    }
}
