//! Qdrant vector store implementation.
//!
//! This module provides integration with Qdrant vector database
//! for persistent episodic memory storage.
//!
//! # Setup
//!
//! Run Qdrant locally with Docker:
//! ```bash
//! docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant
//! ```

use async_trait::async_trait;
use qdrant_client::qdrant::{
    CreateCollectionBuilder, Distance, PointStruct, SearchPointsBuilder,
    VectorParamsBuilder, UpsertPointsBuilder, DeletePointsBuilder,
    PointsIdsList, CountPointsBuilder,
};
use qdrant_client::Qdrant;
use serde_json::Value;
use std::collections::HashMap;

use super::{SearchResult, VectorStore, VectorStoreConfig};

/// Qdrant-based vector store implementation.
///
/// Connects to Qdrant via gRPC on port 6334 by default.
pub struct QdrantVectorStore {
    client: Qdrant,
    config: VectorStoreConfig,
}

impl QdrantVectorStore {
    /// Create a new Qdrant vector store with the given configuration.
    ///
    /// Connects to the Qdrant server and ensures the collection exists.
    pub async fn new(config: VectorStoreConfig) -> anyhow::Result<Self> {
        let client = Qdrant::from_url(&config.endpoint).build()?;

        let store = Self { client, config };
        store.ensure_collection().await?;

        Ok(store)
    }

    /// Create with default configuration (localhost:6334).
    pub async fn connect_default() -> anyhow::Result<Self> {
        Self::new(VectorStoreConfig::default()).await
    }

    /// Initialize the collection if it doesn't exist.
    pub async fn ensure_collection(&self) -> anyhow::Result<()> {
        let exists = self
            .client
            .collection_exists(&self.config.collection_name)
            .await?;

        if !exists {
            tracing::info!(
                "Creating Qdrant collection '{}' with dimension {}",
                self.config.collection_name,
                self.config.dimension
            );

            self.client
                .create_collection(
                    CreateCollectionBuilder::new(&self.config.collection_name)
                        .vectors_config(VectorParamsBuilder::new(
                            self.config.dimension as u64,
                            Distance::Cosine,
                        )),
                )
                .await?;
        }

        Ok(())
    }

    /// Get the configuration.
    pub fn config(&self) -> &VectorStoreConfig {
        &self.config
    }

    /// Convert serde_json::Value to Qdrant payload
    fn json_to_payload(document: &str, metadata: Option<Value>) -> qdrant_client::Payload {
        let mut map = HashMap::new();
        map.insert("document".to_string(), Value::String(document.to_string()));

        if let Some(Value::Object(obj)) = metadata {
            for (k, v) in obj {
                map.insert(k, v);
            }
        }

        qdrant_client::Payload::try_from(serde_json::Value::Object(
            map.into_iter().collect()
        )).unwrap_or_default()
    }
}

#[async_trait]
impl VectorStore for QdrantVectorStore {
    async fn add(
        &self,
        id: &str,
        embedding: &[f32],
        document: &str,
        metadata: Option<Value>,
    ) -> anyhow::Result<()> {
        let payload = Self::json_to_payload(document, metadata);

        let point = PointStruct::new(id.to_string(), embedding.to_vec(), payload);

        self.client
            .upsert_points(UpsertPointsBuilder::new(
                &self.config.collection_name,
                vec![point],
            ))
            .await?;

        tracing::debug!("Added point {} to Qdrant collection", id);
        Ok(())
    }

    async fn add_batch(
        &self,
        items: Vec<(String, Vec<f32>, String, Option<Value>)>,
    ) -> anyhow::Result<()> {
        if items.is_empty() {
            return Ok(());
        }

        let points: Vec<PointStruct> = items
            .into_iter()
            .map(|(id, embedding, document, metadata)| {
                let payload = Self::json_to_payload(&document, metadata);
                PointStruct::new(id, embedding, payload)
            })
            .collect();

        let count = points.len();
        self.client
            .upsert_points(UpsertPointsBuilder::new(
                &self.config.collection_name,
                points,
            ))
            .await?;

        tracing::debug!("Added {} points to Qdrant collection in batch", count);
        Ok(())
    }

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        _filter: Option<Value>,
    ) -> anyhow::Result<Vec<SearchResult>> {
        if _filter.is_some() {
            tracing::warn!("Qdrant search filter is currently ignored (not implemented)");
        }
        let response = self
            .client
            .search_points(
                SearchPointsBuilder::new(
                    &self.config.collection_name,
                    query_embedding.to_vec(),
                    limit as u64,
                )
                .with_payload(true),
            )
            .await?;

        let results: Vec<SearchResult> = response
            .result
            .into_iter()
            .map(|point| {
                let id = point
                    .id
                    .map(|pid| format!("{:?}", pid))
                    .unwrap_or_default();

                let document = point
                    .payload
                    .get("document")
                    .and_then(|v| {
                        // Extract string from Qdrant Value
                        if let Some(s) = v.as_str() {
                            Some(s.to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default();

                SearchResult {
                    id,
                    score: point.score as f64,
                    document,
                    metadata: None,
                }
            })
            .collect();

        Ok(results)
    }

    async fn delete(&self, id: &str) -> anyhow::Result<()> {
        self.client
            .delete_points(
                DeletePointsBuilder::new(&self.config.collection_name).points(
                    PointsIdsList {
                        ids: vec![id.to_string().into()],
                    },
                ),
            )
            .await?;

        tracing::debug!("Deleted point {} from Qdrant collection", id);
        Ok(())
    }

    async fn delete_batch(&self, ids: &[String]) -> anyhow::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }

        let point_ids: Vec<_> = ids.iter().map(|id| id.clone().into()).collect();

        self.client
            .delete_points(
                DeletePointsBuilder::new(&self.config.collection_name)
                    .points(PointsIdsList { ids: point_ids }),
            )
            .await?;

        tracing::debug!("Deleted {} points from Qdrant collection", ids.len());
        Ok(())
    }

    async fn count(&self) -> anyhow::Result<usize> {
        let response = self
            .client
            .count(CountPointsBuilder::new(&self.config.collection_name))
            .await?;

        Ok(response.result.map(|r| r.count as usize).unwrap_or(0))
    }

    async fn clear(&self) -> anyhow::Result<()> {
        // Delete and recreate the collection
        let _ = self
            .client
            .delete_collection(&self.config.collection_name)
            .await;

        self.ensure_collection().await?;

        tracing::info!("Cleared Qdrant collection '{}'", self.config.collection_name);
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
        assert!(config.endpoint.contains("6334"));
    }
}
