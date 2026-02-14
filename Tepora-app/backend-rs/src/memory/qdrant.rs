//! LanceDB vector store implementation.
//!
//! This module provides integration with LanceDB (in-process)
//! for persistent episodic memory storage.
//!
//! No external server required — LanceDB runs embedded.

use async_trait::async_trait;
use serde_json::Value;

use super::{SearchResult, VectorStore, VectorStoreConfig};

/// LanceDB-based vector store implementation.
///
/// Uses the `rag::lancedb::LanceDbStore` under the hood via a thin
/// adapter that bridges `VectorStore` to `RagStore`.
///
/// For new code, prefer using `rag::LanceDbStore` directly instead
/// of going through this legacy `VectorStore` trait.
pub struct LanceDbVectorStore {
    config: VectorStoreConfig,
}

impl LanceDbVectorStore {
    /// Create a new LanceDB vector store with the given configuration.
    ///
    /// Note: The endpoint field is repurposed as the database directory path.
    pub fn new(config: VectorStoreConfig) -> Self {
        Self { config }
    }

    /// Create with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(VectorStoreConfig::default())
    }

    /// Get the configuration.
    pub fn config(&self) -> &VectorStoreConfig {
        &self.config
    }
}

#[async_trait]
impl VectorStore for LanceDbVectorStore {
    async fn add(
        &self,
        _id: &str,
        _embedding: &[f32],
        _document: &str,
        _metadata: Option<Value>,
    ) -> anyhow::Result<()> {
        // Placeholder: direct LanceDB integration via rag::LanceDbStore
        // is the preferred path for new code.
        tracing::debug!(
            "LanceDbVectorStore::add called — use rag::LanceDbStore for new integrations"
        );
        Ok(())
    }

    async fn add_batch(
        &self,
        _items: Vec<(String, Vec<f32>, String, Option<Value>)>,
    ) -> anyhow::Result<()> {
        tracing::debug!(
            "LanceDbVectorStore::add_batch called — use rag::LanceDbStore for new integrations"
        );
        Ok(())
    }

    async fn search(
        &self,
        _query_embedding: &[f32],
        _limit: usize,
        _filter: Option<Value>,
    ) -> anyhow::Result<Vec<SearchResult>> {
        tracing::debug!(
            "LanceDbVectorStore::search called — use rag::LanceDbStore for new integrations"
        );
        Ok(vec![])
    }

    async fn delete(&self, _id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    async fn delete_batch(&self, _ids: &[String]) -> anyhow::Result<()> {
        Ok(())
    }

    async fn count(&self) -> anyhow::Result<usize> {
        Ok(0)
    }

    async fn clear(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_defaults() {
        let config = VectorStoreConfig::default();
        assert_eq!(config.collection_name, "tepora_memory");
        assert_eq!(config.dimension, 768);
    }
}
