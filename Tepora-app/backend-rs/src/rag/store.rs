//! RagStore trait — abstract interface for RAG storage backends.
//!
//! Provides a clean abstraction over vector databases for the RAG pipeline.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::core::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredChunk {
    pub chunk_id: String,
    pub content: String,
    pub source: String,
    pub session_id: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkSearchResult {
    pub chunk: StoredChunk,
    pub score: f32,
}

#[async_trait]
pub trait RagStore: Send + Sync {
    async fn insert(&self, chunk: StoredChunk, embedding: Vec<f32>) -> Result<(), ApiError>;

    async fn insert_batch(&self, items: Vec<(StoredChunk, Vec<f32>)>) -> Result<(), ApiError>;

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<ChunkSearchResult>, ApiError>;

    async fn text_search(
        &self,
        pattern: &str,
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<StoredChunk>, ApiError>;

    async fn get_chunk(&self, chunk_id: &str) -> Result<Option<StoredChunk>, ApiError>;

    async fn get_chunk_window(
        &self,
        chunk_id: &str,
        max_chars: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<StoredChunk>, ApiError>;

    async fn delete_session(&self, session_id: &str) -> Result<usize, ApiError>;

    async fn clear_session(&self, session_id: &str) -> Result<usize, ApiError> {
        self.delete_session(session_id).await
    }

    async fn delete_chunk(&self, chunk_id: &str) -> Result<bool, ApiError>;

    async fn count(&self, session_id: Option<&str>) -> Result<usize, ApiError>;

    async fn reindex_with_model(&self, embedding_model: &str) -> Result<(), ApiError>;

    async fn reindex(&self) -> Result<(), ApiError> {
        self.reindex_with_model("default").await
    }
}
