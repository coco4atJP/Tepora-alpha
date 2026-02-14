//! RagStore trait — abstract interface for RAG storage backends.
//!
//! Provides a clean abstraction over vector databases for the RAG pipeline.
//! The primary implementation is `LanceDbStore` in the `lancedb` module.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::core::errors::ApiError;

/// A stored RAG chunk with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredChunk {
    /// Unique chunk identifier.
    pub chunk_id: String,
    /// The text content of the chunk.
    pub content: String,
    /// Source identifier (URL, filename, session, etc.).
    pub source: String,
    /// Session ID that owns this chunk.
    pub session_id: String,
    /// Optional metadata (JSON).
    pub metadata: Option<serde_json::Value>,
}

/// Result of a similarity search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkSearchResult {
    pub chunk: StoredChunk,
    /// Similarity score (higher = better).
    pub score: f32,
}

/// Abstract trait for RAG storage backends.
///
/// Implementations should support:
/// - Vector similarity search
/// - Session-scoped chunk management
/// - Index reset on embedding model change
#[async_trait]
pub trait RagStore: Send + Sync {
    /// Insert a chunk with its embedding vector.
    async fn insert(
        &self,
        chunk: StoredChunk,
        embedding: Vec<f32>,
    ) -> Result<(), ApiError>;

    /// Insert multiple chunks in batch.
    async fn insert_batch(
        &self,
        items: Vec<(StoredChunk, Vec<f32>)>,
    ) -> Result<(), ApiError>;

    /// Search for chunks similar to the query embedding.
    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<ChunkSearchResult>, ApiError>;

    /// Delete all chunks for a session.
    async fn delete_session(&self, session_id: &str) -> Result<usize, ApiError>;

    /// Delete a specific chunk by ID.
    async fn delete_chunk(&self, chunk_id: &str) -> Result<bool, ApiError>;

    /// Get the total chunk count (optionally filtered by session).
    async fn count(&self, session_id: Option<&str>) -> Result<usize, ApiError>;

    /// Clear all data and rebuild the index.
    ///
    /// Used when the embedding model changes and all vectors are invalidated.
    async fn reindex(&self) -> Result<(), ApiError>;
}
