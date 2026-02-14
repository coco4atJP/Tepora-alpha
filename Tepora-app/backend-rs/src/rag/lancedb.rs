//! LanceDB-backed RAG store implementation.
//!
//! In-process vector store using LanceDB (Lance columnar format) for
//! high-performance vector similarity search.  No external server or
//! protobuf compiler required — LanceDB runs fully embedded.
//!
//! ## Migration from SqliteRagStore
//!
//! This module replaces the previous SQLite + brute-force cosine similarity
//! implementation with LanceDB's native ANN (Approximate Nearest Neighbor)
//! search, providing:
//!
//! - **Sub-linear search**: IVF-PQ indexing for large-scale datasets
//! - **Zero-copy reads**: Arrow columnar format avoids serialization overhead
//! - **Automatic versioning**: Built-in data versioning at the storage layer

use std::path::PathBuf;
use std::sync::Arc;

use arrow_array::{
    Array, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use async_trait::async_trait;
use futures::TryStreamExt;

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;

use super::store::{ChunkSearchResult, RagStore, StoredChunk};

/// Dimension sentinel: set on first insert; subsequent inserts must match.
///
/// LanceDB's `FixedSizeList` requires a compile-time-ish dimension, so we
/// store it after the first write and validate all later embeddings against it.
const TABLE_NAME: &str = "rag_chunks";

// ---------------------------------------------------------------------------
// LanceDbRagStore
// ---------------------------------------------------------------------------

/// LanceDB-backed RAG store.
///
/// Stores chunk text + metadata alongside embedding vectors in a single
/// LanceDB table.  Supports native ANN search via IVF-PQ once the table
/// grows large enough to benefit from indexing.
pub struct LanceDbRagStore {
    db: lancedb::Connection,
    #[allow(dead_code)]
    db_path: PathBuf,
    /// Embedding dimension — determined on first insert.
    dimension: tokio::sync::RwLock<Option<i32>>,
}

impl LanceDbRagStore {
    /// Create a new store at the default location (`<user_data_dir>/lancedb`).
    pub async fn new(paths: &AppPaths) -> Result<Self, ApiError> {
        let db_path = paths.user_data_dir.join("lancedb");
        Self::with_path(db_path).await
    }

    /// Create with a custom path (for testing).
    pub async fn with_path(db_path: PathBuf) -> Result<Self, ApiError> {
        let path_str = db_path.to_string_lossy().to_string();
        let db = lancedb::connect(&path_str)
            .execute()
            .await
            .map_err(ApiError::internal)?;

        let store = Self {
            db,
            db_path,
            dimension: tokio::sync::RwLock::new(None),
        };

        // Probe existing table for dimension info
        store.probe_dimension().await;

        Ok(store)
    }

    /// Try to read dimension from an existing table.
    async fn probe_dimension(&self) {
        if let Ok(table) = self.db.open_table(TABLE_NAME).execute().await {
            if let Ok(schema) = table.schema().await {
                for field in schema.fields() {
                    if field.name() == "vector" {
                        if let DataType::FixedSizeList(_, dim) = field.data_type() {
                            let mut guard = self.dimension.write().await;
                            *guard = Some(*dim);
                            tracing::debug!("LanceDB: probed existing dimension = {}", dim);
                        }
                    }
                }
            }
        }
    }

    /// Get or create the table with the given embedding dimension.
    async fn ensure_table(
        &self,
        dim: i32,
    ) -> Result<lancedb::Table, ApiError> {
        // Fast path: table already exists
        if let Ok(table) = self.db.open_table(TABLE_NAME).execute().await {
            return Ok(table);
        }

        // Slow path: create table with an initial empty batch
        let schema = Self::make_schema(dim);
        let empty_batch = RecordBatch::new_empty(schema.clone());
        let batches = RecordBatchIterator::new(
            vec![Ok(empty_batch)],
            schema,
        );
        let table = self
            .db
            .create_table(TABLE_NAME, Box::new(batches))
            .execute()
            .await
            .map_err(ApiError::internal)?;

        tracing::info!("LanceDB: created table '{}' with dim={}", TABLE_NAME, dim);
        Ok(table)
    }

    /// Build the Arrow schema for the RAG chunks table.
    fn make_schema(dim: i32) -> Arc<Schema> {
        Arc::new(Schema::new(vec![
            Field::new("chunk_id", DataType::Utf8, false),
            Field::new("content", DataType::Utf8, false),
            Field::new("source", DataType::Utf8, false),
            Field::new("session_id", DataType::Utf8, false),
            Field::new("metadata", DataType::Utf8, true),
            Field::new(
                "vector",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, true)),
                    dim,
                ),
                true,
            ),
        ]))
    }

    /// Convert items into a RecordBatch for insertion.
    fn items_to_batch(
        items: &[(StoredChunk, Vec<f32>)],
        dim: i32,
    ) -> Result<RecordBatch, ApiError> {
        let chunk_ids: Vec<&str> = items.iter().map(|(c, _)| c.chunk_id.as_str()).collect();
        let contents: Vec<&str> = items.iter().map(|(c, _)| c.content.as_str()).collect();
        let sources: Vec<&str> = items.iter().map(|(c, _)| c.source.as_str()).collect();
        let session_ids: Vec<&str> = items.iter().map(|(c, _)| c.session_id.as_str()).collect();
        let metadata_strs: Vec<String> = items
            .iter()
            .map(|(c, _)| {
                c.metadata
                    .as_ref()
                    .map(|m| serde_json::to_string(m).unwrap_or_else(|_| "{}".to_string()))
                    .unwrap_or_else(|| "{}".to_string())
            })
            .collect();
        let metadata_refs: Vec<&str> = metadata_strs.iter().map(|s| s.as_str()).collect();

        // Build FixedSizeList of embeddings
        let flat_values: Vec<f32> = items.iter().flat_map(|(_, emb)| emb.clone()).collect();
        let values_array = Float32Array::from(flat_values);
        let list_array = FixedSizeListArray::try_new_from_values(values_array, dim)
            .map_err(|e| ApiError::Internal(format!("Failed to build vector array: {e}")))?;

        let schema = Self::make_schema(dim);
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(chunk_ids)),
                Arc::new(StringArray::from(contents)),
                Arc::new(StringArray::from(sources)),
                Arc::new(StringArray::from(session_ids)),
                Arc::new(StringArray::from(metadata_refs)),
                Arc::new(list_array),
            ],
        )
        .map_err(|e| ApiError::Internal(format!("Failed to build RecordBatch: {e}")))?;

        Ok(batch)
    }

    /// Get the embedding dimension, setting it on first call.
    async fn get_or_set_dim(&self, embedding_len: usize) -> Result<i32, ApiError> {
        let dim = embedding_len as i32;
        {
            let guard = self.dimension.read().await;
            if let Some(existing) = *guard {
                if existing != dim {
                    return Err(ApiError::BadRequest(format!(
                        "Embedding dimension mismatch: store expects {}, got {}",
                        existing, dim
                    )));
                }
                return Ok(existing);
            }
        }
        // First time — set it
        let mut guard = self.dimension.write().await;
        // Double-check after acquiring write lock
        if let Some(existing) = *guard {
            if existing != dim {
                return Err(ApiError::BadRequest(format!(
                    "Embedding dimension mismatch: store expects {}, got {}",
                    existing, dim
                )));
            }
            return Ok(existing);
        }
        *guard = Some(dim);
        Ok(dim)
    }
}

#[async_trait]
impl RagStore for LanceDbRagStore {
    async fn insert(
        &self,
        chunk: StoredChunk,
        embedding: Vec<f32>,
    ) -> Result<(), ApiError> {
        self.insert_batch(vec![(chunk, embedding)]).await
    }

    async fn insert_batch(
        &self,
        items: Vec<(StoredChunk, Vec<f32>)>,
    ) -> Result<(), ApiError> {
        if items.is_empty() {
            return Ok(());
        }

        let dim = self.get_or_set_dim(items[0].1.len()).await?;

        // Validate all embeddings have the same dimension
        for (i, (_, emb)) in items.iter().enumerate() {
            if emb.len() as i32 != dim {
                return Err(ApiError::BadRequest(format!(
                    "Embedding dimension mismatch at index {}: expected {}, got {}",
                    i, dim, emb.len()
                )));
            }
        }

        // Delete existing chunks with the same IDs (upsert semantics)
        let chunk_ids: Vec<&str> = items.iter().map(|(c, _)| c.chunk_id.as_str()).collect();
        let table = self.ensure_table(dim).await?;

        // Build filter for existing chunk_ids
        let id_list: Vec<String> = chunk_ids.iter().map(|id| format!("'{}'", id.replace('\'', "''"))).collect();
        let filter = format!("chunk_id IN ({})", id_list.join(", "));
        let _ = table.delete(&filter).await; // ignore error if nothing to delete

        // Insert new batch
        let batch = Self::items_to_batch(&items, dim)?;
        let schema = batch.schema();
        let batches = RecordBatchIterator::new(vec![Ok(batch)], schema);
        table
            .add(Box::new(batches))
            .execute()
            .await
            .map_err(ApiError::internal)?;

        tracing::debug!("LanceDB: inserted {} chunks", items.len());
        Ok(())
    }

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<ChunkSearchResult>, ApiError> {
        let dim = {
            let guard = self.dimension.read().await;
            match *guard {
                Some(d) => d,
                None => {
                    // No data inserted yet — return empty results
                    return Ok(vec![]);
                }
            }
        };

        if query_embedding.len() as i32 != dim {
            return Err(ApiError::BadRequest(format!(
                "Query embedding dimension mismatch: expected {}, got {}",
                dim,
                query_embedding.len()
            )));
        }

        let table = match self.db.open_table(TABLE_NAME).execute().await {
            Ok(t) => t,
            Err(_) => return Ok(vec![]), // Table doesn't exist yet
        };

        let query_vec: Vec<f32> = query_embedding.to_vec();

        let mut builder = table
            .vector_search(query_vec)
            .map_err(ApiError::internal)?
            .limit(limit)
            .distance_type(lancedb::DistanceType::Cosine);

        // Apply session filter if provided
        if let Some(sid) = session_id {
            let filter = format!("session_id = '{}'", sid.replace('\'', "''"));
            builder = builder.only_if(filter);
        }

        let results = builder
            .execute()
            .await
            .map_err(ApiError::internal)?
            .try_collect::<Vec<RecordBatch>>()
            .await
            .map_err(ApiError::internal)?;

        let mut search_results = Vec::new();

        for batch in &results {
            let chunk_id_col = batch
                .column_by_name("chunk_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let content_col = batch
                .column_by_name("content")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let source_col = batch
                .column_by_name("source")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let session_col = batch
                .column_by_name("session_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let metadata_col = batch
                .column_by_name("metadata")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let distance_col = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

            let (
                Some(chunk_ids),
                Some(contents),
                Some(sources),
                Some(sessions),
            ) = (chunk_id_col, content_col, source_col, session_col)
            else {
                continue;
            };

            for i in 0..batch.num_rows() {
                let metadata = metadata_col
                    .and_then(|col| col.value(i).parse::<serde_json::Value>().ok());

                // LanceDB returns cosine _distance_ (0 = identical, 2 = opposite).
                // Convert to similarity score: score = 1 - distance
                let distance = distance_col.map(|col| col.value(i)).unwrap_or(0.0);
                let score = 1.0 - distance;

                search_results.push(ChunkSearchResult {
                    chunk: StoredChunk {
                        chunk_id: chunk_ids.value(i).to_string(),
                        content: contents.value(i).to_string(),
                        source: sources.value(i).to_string(),
                        session_id: sessions.value(i).to_string(),
                        metadata,
                    },
                    score,
                });
            }
        }

        // Results should already be sorted by distance (ascending) from LanceDB,
        // but we sort by score (descending) to be safe.
        search_results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        search_results.truncate(limit);

        Ok(search_results)
    }

    async fn delete_session(&self, session_id: &str) -> Result<usize, ApiError> {
        let table = match self.db.open_table(TABLE_NAME).execute().await {
            Ok(t) => t,
            Err(_) => return Ok(0),
        };

        // Count before delete
        let count_before = self.count(Some(session_id)).await.unwrap_or(0);

        let filter = format!(
            "session_id = '{}'",
            session_id.replace('\'', "''")
        );
        table
            .delete(&filter)
            .await
            .map_err(ApiError::internal)?;

        tracing::debug!(
            "LanceDB: deleted session '{}' ({} chunks)",
            session_id,
            count_before
        );
        Ok(count_before)
    }

    async fn delete_chunk(&self, chunk_id: &str) -> Result<bool, ApiError> {
        let table = match self.db.open_table(TABLE_NAME).execute().await {
            Ok(t) => t,
            Err(_) => return Ok(false),
        };

        let filter = format!(
            "chunk_id = '{}'",
            chunk_id.replace('\'', "''")
        );
        table
            .delete(&filter)
            .await
            .map_err(ApiError::internal)?;

        // LanceDB delete doesn't return affected count easily,
        // assume success if no error.
        Ok(true)
    }

    async fn count(&self, session_id: Option<&str>) -> Result<usize, ApiError> {
        let table = match self.db.open_table(TABLE_NAME).execute().await {
            Ok(t) => t,
            Err(_) => return Ok(0),
        };

        let batches = if let Some(sid) = session_id {
            let filter = format!("session_id = '{}'", sid.replace('\'', "''"));
            table
                .query()
                .only_if(filter)
                .select(lancedb::query::Select::columns(&["chunk_id"]))
                .execute()
                .await
                .map_err(ApiError::internal)?
                .try_collect::<Vec<RecordBatch>>()
                .await
                .map_err(ApiError::internal)?
        } else {
            table
                .query()
                .select(lancedb::query::Select::columns(&["chunk_id"]))
                .execute()
                .await
                .map_err(ApiError::internal)?
                .try_collect::<Vec<RecordBatch>>()
                .await
                .map_err(ApiError::internal)?
        };

        let total: usize = batches.iter().map(|b| b.num_rows()).sum();
        Ok(total)
    }

    async fn reindex(&self) -> Result<(), ApiError> {
        // Drop the table entirely and reset dimension
        let _ = self.db.drop_table(TABLE_NAME).await;
        {
            let mut guard = self.dimension.write().await;
            *guard = None;
        }
        tracing::info!("LanceDB: dropped table '{}' for reindex", TABLE_NAME);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_store() -> LanceDbRagStore {
        let tmp = std::env::temp_dir().join(format!(
            "tepora-lancedb-test-{}",
            uuid::Uuid::new_v4()
        ));
        LanceDbRagStore::with_path(tmp).await.unwrap()
    }

    #[tokio::test]
    async fn insert_and_search() {
        let store = test_store().await;

        let chunk = StoredChunk {
            chunk_id: "c1".to_string(),
            content: "Hello world".to_string(),
            source: "test".to_string(),
            session_id: "s1".to_string(),
            metadata: None,
        };
        let embedding = vec![1.0, 0.0, 0.0, 0.0];

        store.insert(chunk, embedding.clone()).await.unwrap();
        assert_eq!(store.count(None).await.unwrap(), 1);

        let results = store.search(&embedding, 10, None).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].chunk.chunk_id, "c1");
        // Cosine distance to itself = 0.0, so score = 1.0
        assert!(results[0].score > 0.99);
    }

    #[tokio::test]
    async fn session_filter() {
        let store = test_store().await;

        for (id, session) in [("c1", "s1"), ("c2", "s2"), ("c3", "s1")] {
            store
                .insert(
                    StoredChunk {
                        chunk_id: id.to_string(),
                        content: "test".to_string(),
                        source: "src".to_string(),
                        session_id: session.to_string(),
                        metadata: None,
                    },
                    vec![1.0, 0.0, 0.0, 0.0],
                )
                .await
                .unwrap();
        }

        assert_eq!(store.count(Some("s1")).await.unwrap(), 2);
        assert_eq!(store.count(Some("s2")).await.unwrap(), 1);

        let deleted = store.delete_session("s1").await.unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(store.count(None).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn reindex_clears_all() {
        let store = test_store().await;

        store
            .insert(
                StoredChunk {
                    chunk_id: "c1".to_string(),
                    content: "data".to_string(),
                    source: "src".to_string(),
                    session_id: "s1".to_string(),
                    metadata: None,
                },
                vec![1.0, 0.0, 0.0, 0.0],
            )
            .await
            .unwrap();

        assert_eq!(store.count(None).await.unwrap(), 1);
        store.reindex().await.unwrap();
        assert_eq!(store.count(None).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn batch_insert() {
        let store = test_store().await;

        let items: Vec<(StoredChunk, Vec<f32>)> = (0..5)
            .map(|i| {
                (
                    StoredChunk {
                        chunk_id: format!("c{}", i),
                        content: format!("content {}", i),
                        source: "batch_test".to_string(),
                        session_id: "s1".to_string(),
                        metadata: None,
                    },
                    vec![i as f32, 1.0, 0.0, 0.0],
                )
            })
            .collect();

        store.insert_batch(items).await.unwrap();
        assert_eq!(store.count(None).await.unwrap(), 5);
    }

    #[tokio::test]
    async fn upsert_semantics() {
        let store = test_store().await;

        // Insert initial chunk
        store
            .insert(
                StoredChunk {
                    chunk_id: "c1".to_string(),
                    content: "original".to_string(),
                    source: "test".to_string(),
                    session_id: "s1".to_string(),
                    metadata: None,
                },
                vec![1.0, 0.0, 0.0, 0.0],
            )
            .await
            .unwrap();

        // Upsert with same chunk_id
        store
            .insert(
                StoredChunk {
                    chunk_id: "c1".to_string(),
                    content: "updated".to_string(),
                    source: "test".to_string(),
                    session_id: "s1".to_string(),
                    metadata: None,
                },
                vec![0.0, 1.0, 0.0, 0.0],
            )
            .await
            .unwrap();

        // Should still be 1 chunk (upsert, not duplicate)
        assert_eq!(store.count(None).await.unwrap(), 1);

        let results = store.search(&[0.0, 1.0, 0.0, 0.0], 10, None).await.unwrap();
        assert_eq!(results[0].chunk.content, "updated");
    }
}
