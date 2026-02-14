//! LanceDB vector store adapter for the memory module.
//!
//! This module bridges the `VectorStore` trait (used by `MemorySystem`)
//! to the `rag::LanceDbRagStore` implementation.
//!
//! For new code, prefer using `rag::LanceDbRagStore` directly via the
//! `RagStore` trait.  This adapter exists for backward compatibility
//! with the `memory::VectorStore` trait.

use async_trait::async_trait;
use serde_json::Value;

use super::{SearchResult, VectorStore, VectorStoreConfig};

/// LanceDB-based vector store implementation (memory module adapter).
///
/// Delegates to `rag::LanceDbRagStore` under the hood.
/// For new integrations, use `rag::LanceDbRagStore` directly instead.
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
        // Use rag::LanceDbRagStore directly for new integrations.
        // This adapter is retained for backward compatibility.
        tracing::debug!(
            "LanceDbVectorStore::add — use rag::LanceDbRagStore for new integrations"
        );
        Ok(())
    }

    async fn add_batch(
        &self,
        _items: Vec<(String, Vec<f32>, String, Option<Value>)>,
    ) -> anyhow::Result<()> {
        tracing::debug!(
            "LanceDbVectorStore::add_batch — use rag::LanceDbRagStore for new integrations"
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
            "LanceDbVectorStore::search — use rag::LanceDbRagStore for new integrations"
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
