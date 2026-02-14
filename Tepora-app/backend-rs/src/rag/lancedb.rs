//! SQLite-backed RAG store implementation.
//!
//! In-process vector store using SQLite for metadata and
//! ndarray-based cosine similarity for search.
//! No external server or protobuf compiler required.

use std::path::PathBuf;

use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;
use super::store::{ChunkSearchResult, RagStore, StoredChunk};

/// SQLite-backed RAG store.
///
/// Stores chunk text + metadata in SQLite, with serialized
/// embeddings for brute-force cosine similarity search.
///
/// This is a lightweight, zero-dependency alternative suitable
/// for moderate-scale RAG. For large-scale deployments, consider
/// migrating to LanceDB (requires protoc + heavy deps).
pub struct SqliteRagStore {
    pool: SqlitePool,
    #[allow(dead_code)]
    db_path: PathBuf,
}

impl SqliteRagStore {
    /// Create a new store at the default location.
    pub async fn new(paths: &AppPaths) -> Result<Self, ApiError> {
        let db_path = paths.user_data_dir.join("rag.db");
        Self::with_path(db_path).await
    }

    /// Create with a custom path (for testing).
    pub async fn with_path(db_path: PathBuf) -> Result<Self, ApiError> {
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(ApiError::internal)?;

        let store = Self { pool, db_path };
        store.init_schema().await?;
        Ok(store)
    }

    async fn init_schema(&self) -> Result<(), ApiError> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS rag_chunks (
                chunk_id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL DEFAULT '',
                metadata TEXT DEFAULT '{}',
                embedding BLOB,
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_rag_session ON rag_chunks(session_id)",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(())
    }

    /// Serialize embedding to bytes (little-endian f32).
    fn serialize_embedding(embedding: &[f32]) -> Vec<u8> {
        embedding
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect()
    }

    /// Deserialize embedding from bytes.
    fn deserialize_embedding(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect()
    }

    /// Compute cosine similarity between two vectors.
    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        if a.len() != b.len() || a.is_empty() {
            return 0.0;
        }

        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        let denom = norm_a * norm_b;

        if denom <= f32::EPSILON {
            0.0
        } else {
            dot / denom
        }
    }
}

#[async_trait]
impl RagStore for SqliteRagStore {
    async fn insert(
        &self,
        chunk: StoredChunk,
        embedding: Vec<f32>,
    ) -> Result<(), ApiError> {
        let blob = Self::serialize_embedding(&embedding);
        let metadata_str = chunk
            .metadata
            .as_ref()
            .map(|m| serde_json::to_string(m).unwrap_or_default())
            .unwrap_or_else(|| "{}".to_string());

        sqlx::query(
            "INSERT OR REPLACE INTO rag_chunks (chunk_id, content, source, session_id, metadata, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(&chunk.chunk_id)
        .bind(&chunk.content)
        .bind(&chunk.source)
        .bind(&chunk.session_id)
        .bind(&metadata_str)
        .bind(&blob)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(())
    }

    async fn insert_batch(
        &self,
        items: Vec<(StoredChunk, Vec<f32>)>,
    ) -> Result<(), ApiError> {
        if items.is_empty() {
            return Ok(());
        }

        let mut tx = self.pool.begin().await.map_err(ApiError::internal)?;

        for (chunk, embedding) in &items {
            let blob = Self::serialize_embedding(embedding);
            let metadata_str = chunk
                .metadata
                .as_ref()
                .map(|m| serde_json::to_string(m).unwrap_or_default())
                .unwrap_or_else(|| "{}".to_string());

            sqlx::query(
                "INSERT OR REPLACE INTO rag_chunks (chunk_id, content, source, session_id, metadata, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .bind(&chunk.chunk_id)
            .bind(&chunk.content)
            .bind(&chunk.source)
            .bind(&chunk.session_id)
            .bind(&metadata_str)
            .bind(&blob)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        }

        tx.commit().await.map_err(ApiError::internal)?;
        tracing::debug!("Inserted {} chunks into RAG store", items.len());
        Ok(())
    }

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<ChunkSearchResult>, ApiError> {
        // Fetch candidates from DB (optionally filtered by session)
        let rows = if let Some(sid) = session_id {
            sqlx::query(
                "SELECT chunk_id, content, source, session_id, metadata, embedding
                 FROM rag_chunks WHERE session_id = ?1",
            )
            .bind(sid)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT chunk_id, content, source, session_id, metadata, embedding
                 FROM rag_chunks",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };

        // Score each chunk via cosine similarity
        let mut scored: Vec<ChunkSearchResult> = rows
            .iter()
            .filter_map(|row| {
                let embedding_bytes: Vec<u8> = row.get("embedding");
                if embedding_bytes.is_empty() {
                    return None;
                }
                let stored_emb = Self::deserialize_embedding(&embedding_bytes);
                let score = Self::cosine_similarity(query_embedding, &stored_emb);

                let metadata_str: String = row.get("metadata");
                let metadata = serde_json::from_str(&metadata_str).ok();

                Some(ChunkSearchResult {
                    chunk: StoredChunk {
                        chunk_id: row.get("chunk_id"),
                        content: row.get("content"),
                        source: row.get("source"),
                        session_id: row.get("session_id"),
                        metadata,
                    },
                    score,
                })
            })
            .collect();

        // Sort by score descending and take top-k
        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(limit);

        Ok(scored)
    }

    async fn delete_session(&self, session_id: &str) -> Result<usize, ApiError> {
        let result = sqlx::query("DELETE FROM rag_chunks WHERE session_id = ?1")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        Ok(result.rows_affected() as usize)
    }

    async fn delete_chunk(&self, chunk_id: &str) -> Result<bool, ApiError> {
        let result = sqlx::query("DELETE FROM rag_chunks WHERE chunk_id = ?1")
            .bind(chunk_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        Ok(result.rows_affected() > 0)
    }

    async fn count(&self, session_id: Option<&str>) -> Result<usize, ApiError> {
        let count: i64 = if let Some(sid) = session_id {
            sqlx::query_scalar("SELECT COUNT(*) FROM rag_chunks WHERE session_id = ?1")
                .bind(sid)
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
        } else {
            sqlx::query_scalar("SELECT COUNT(*) FROM rag_chunks")
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
        };

        Ok(count as usize)
    }

    async fn reindex(&self) -> Result<(), ApiError> {
        sqlx::query("DELETE FROM rag_chunks")
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        tracing::info!("Cleared all chunks from RAG store for reindex");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_store() -> SqliteRagStore {
        let tmp = std::env::temp_dir().join(format!(
            "tepora-rag-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        SqliteRagStore::with_path(tmp).await.unwrap()
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
        let embedding = vec![1.0, 0.0, 0.0];

        store.insert(chunk, embedding.clone()).await.unwrap();
        assert_eq!(store.count(None).await.unwrap(), 1);

        let results = store.search(&embedding, 10, None).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].chunk.chunk_id, "c1");
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
                    vec![1.0, 0.0],
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
                vec![1.0],
            )
            .await
            .unwrap();

        assert_eq!(store.count(None).await.unwrap(), 1);
        store.reindex().await.unwrap();
        assert_eq!(store.count(None).await.unwrap(), 0);
    }
}
