#![allow(dead_code)]
#![allow(unused_imports)]
//! Memory module for vector storage and episodic memory.
//!
//! This module provides:
//! - `VectorStore` trait for abstraction over different vector databases
//! - `MemorySystem` for high-level episodic memory operations
//! - LanceDB integration for in-process vector storage

mod qdrant;

pub use qdrant::LanceDbVectorStore;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Result of a vector similarity search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// Unique identifier of the matched document
    pub id: String,
    /// Similarity score (higher is more similar)
    pub score: f64,
    /// The stored document/text
    pub document: String,
    /// Optional metadata
    pub metadata: Option<serde_json::Value>,
}

/// Configuration for vector store connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorStoreConfig {
    /// gRPC endpoint for Qdrant (default: http://localhost:6334)
    pub endpoint: String,
    /// Collection name
    pub collection_name: String,
    /// Vector dimension
    pub dimension: usize,
}

impl Default for VectorStoreConfig {
    fn default() -> Self {
        Self {
            endpoint: "http://localhost:6334".to_string(),
            collection_name: "tepora_memory".to_string(),
            dimension: 768, // Common embedding dimension
        }
    }
}

/// Abstract trait for vector storage backends.
///
/// Implementations can use Qdrant, in-memory storage, or other backends.
#[async_trait]
pub trait VectorStore: Send + Sync {
    /// Add a document with its embedding to the store.
    async fn add(
        &self,
        id: &str,
        embedding: &[f32],
        document: &str,
        metadata: Option<serde_json::Value>,
    ) -> anyhow::Result<()>;

    /// Add multiple documents in batch.
    async fn add_batch(
        &self,
        items: Vec<(String, Vec<f32>, String, Option<serde_json::Value>)>,
    ) -> anyhow::Result<()>;

    /// Search for similar documents.
    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        filter: Option<serde_json::Value>,
    ) -> anyhow::Result<Vec<SearchResult>>;

    /// Delete a document by ID.
    async fn delete(&self, id: &str) -> anyhow::Result<()>;

    /// Delete multiple documents by IDs.
    async fn delete_batch(&self, ids: &[String]) -> anyhow::Result<()>;

    /// Get the total count of documents.
    async fn count(&self) -> anyhow::Result<usize>;

    /// Clear all documents from the store.
    async fn clear(&self) -> anyhow::Result<()>;
}

/// High-level memory system for episodic memory management.
///
/// Uses a VectorStore backend for persistence and provides
/// session-scoped memory operations.
pub struct MemorySystem<V: VectorStore> {
    store: V,
    config: VectorStoreConfig,
}

impl<V: VectorStore> MemorySystem<V> {
    /// Create a new memory system with the given vector store.
    pub fn new(store: V, config: VectorStoreConfig) -> Self {
        Self { store, config }
    }

    /// Get the underlying vector store configuration.
    pub fn config(&self) -> &VectorStoreConfig {
        &self.config
    }

    /// Save an episode to memory.
    ///
    /// # Arguments
    /// * `id` - Unique identifier for the episode
    /// * `summary` - Text summary of the episode
    /// * `embedding` - Embedding vector
    /// * `session_id` - Optional session identifier for filtering
    /// * `timestamp` - Unix timestamp
    pub async fn save_episode(
        &self,
        id: &str,
        summary: &str,
        embedding: &[f32],
        session_id: Option<&str>,
        timestamp: f64,
    ) -> anyhow::Result<()> {
        let metadata = serde_json::json!({
            "session_id": session_id,
            "timestamp": timestamp,
        });

        self.store.add(id, embedding, summary, Some(metadata)).await
    }

    /// Retrieve similar episodes.
    ///
    /// # Arguments
    /// * `query_embedding` - Query vector
    /// * `limit` - Maximum number of results
    /// * `session_id` - Optional session filter
    /// * `temporality_boost` - Boost factor for recency (0.0-1.0)
    pub async fn retrieve(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
        temporality_boost: f64,
    ) -> anyhow::Result<Vec<SearchResult>> {
        let filter = session_id.map(|sid| {
            serde_json::json!({
                "session_id": sid
            })
        });

        let mut results = self
            .store
            .search(query_embedding, limit * 2, filter)
            .await?;

        // Apply temporality boost if requested
        if temporality_boost > 0.0 {
            apply_recency_boost(&mut results, temporality_boost);
            results.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        results.truncate(limit);
        Ok(results)
    }

    /// Get the count of stored episodes.
    pub async fn count(&self) -> anyhow::Result<usize> {
        self.store.count().await
    }

    /// Delete an episode by ID.
    pub async fn delete(&self, id: &str) -> anyhow::Result<()> {
        self.store.delete(id).await
    }

    /// Clear all episodes (for testing).
    pub async fn clear(&self) -> anyhow::Result<()> {
        self.store.clear().await
    }
}

/// Apply recency boost to search results based on timestamp metadata.
fn apply_recency_boost(results: &mut [SearchResult], boost_factor: f64) {
    if results.is_empty() {
        return;
    }

    // Extract timestamps
    let timestamps: Vec<f64> = results
        .iter()
        .filter_map(|r| {
            r.metadata
                .as_ref()
                .and_then(|m| m.get("timestamp"))
                .and_then(|t| t.as_f64())
        })
        .collect();

    if timestamps.is_empty() {
        return;
    }

    let max_ts = timestamps.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_ts = timestamps.iter().cloned().fold(f64::INFINITY, f64::min);
    let range = max_ts - min_ts;

    if range <= 0.0 {
        return;
    }

    for result in results.iter_mut() {
        if let Some(ts) = result
            .metadata
            .as_ref()
            .and_then(|m| m.get("timestamp"))
            .and_then(|t| t.as_f64())
        {
            let normalized = (ts - min_ts) / range;
            result.score = result.score * (1.0 - boost_factor) + normalized * boost_factor;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Simple in-memory implementation for testing
    type StoreItem = (String, Vec<f32>, String, Option<serde_json::Value>);

    pub struct InMemoryVectorStore {
        items: std::sync::Mutex<Vec<StoreItem>>,
    }

    impl InMemoryVectorStore {
        pub fn new() -> Self {
            Self {
                items: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl VectorStore for InMemoryVectorStore {
        async fn add(
            &self,
            id: &str,
            embedding: &[f32],
            document: &str,
            metadata: Option<serde_json::Value>,
        ) -> anyhow::Result<()> {
            let mut items = self.items.lock().unwrap();
            items.push((
                id.to_string(),
                embedding.to_vec(),
                document.to_string(),
                metadata,
            ));
            Ok(())
        }

        async fn add_batch(&self, new_items: Vec<StoreItem>) -> anyhow::Result<()> {
            let mut items = self.items.lock().unwrap();
            items.extend(new_items);
            Ok(())
        }

        async fn search(
            &self,
            query: &[f32],
            limit: usize,
            _filter: Option<serde_json::Value>,
        ) -> anyhow::Result<Vec<SearchResult>> {
            let items = self.items.lock().unwrap();
            let mut results: Vec<SearchResult> = items
                .iter()
                .map(|(id, emb, doc, meta)| {
                    let score = cosine_similarity(query, emb);
                    SearchResult {
                        id: id.clone(),
                        score,
                        document: doc.clone(),
                        metadata: meta.clone(),
                    }
                })
                .collect();
            results.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            results.truncate(limit);
            Ok(results)
        }

        async fn delete(&self, id: &str) -> anyhow::Result<()> {
            let mut items = self.items.lock().unwrap();
            items.retain(|(item_id, _, _, _)| item_id != id);
            Ok(())
        }

        async fn delete_batch(&self, ids: &[String]) -> anyhow::Result<()> {
            let mut items = self.items.lock().unwrap();
            items.retain(|(item_id, _, _, _)| !ids.contains(item_id));
            Ok(())
        }

        async fn count(&self) -> anyhow::Result<usize> {
            Ok(self.items.lock().unwrap().len())
        }

        async fn clear(&self) -> anyhow::Result<()> {
            self.items.lock().unwrap().clear();
            Ok(())
        }
    }

    fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
        if a.len() != b.len() || a.is_empty() {
            return 0.0;
        }
        let dot: f64 = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| (*x as f64) * (*y as f64))
            .sum();
        let norm_a: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
        let norm_b: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
        if norm_a == 0.0 || norm_b == 0.0 {
            0.0
        } else {
            dot / (norm_a * norm_b)
        }
    }

    #[tokio::test]
    async fn test_memory_system() {
        let store = InMemoryVectorStore::new();
        let config = VectorStoreConfig::default();
        let memory = MemorySystem::new(store, config);

        // Save an episode
        let embedding = vec![1.0, 0.0, 0.0];
        memory
            .save_episode("e1", "Test episode", &embedding, Some("session1"), 100.0)
            .await
            .unwrap();

        // Check count
        assert_eq!(memory.count().await.unwrap(), 1);

        // Retrieve
        let results = memory.retrieve(&embedding, 5, None, 0.0).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "e1");
    }
}
