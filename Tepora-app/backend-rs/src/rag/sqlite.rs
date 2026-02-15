//! SQLite-backed RAG store implementation.
//!
//! In-process vector store using SQLite for metadata and
//! brute-force cosine similarity for search.

use std::path::PathBuf;

use async_trait::async_trait;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

use super::store::{ChunkSearchResult, RagStore, StoredChunk};
use crate::core::config::AppPaths;
use crate::core::errors::ApiError;

pub struct SqliteRagStore {
    pool: SqlitePool,
    #[allow(dead_code)]
    db_path: PathBuf,
}

impl SqliteRagStore {
    pub async fn new(paths: &AppPaths) -> Result<Self, ApiError> {
        let db_path = paths.user_data_dir.join("rag.db");
        Self::with_path(db_path).await
    }

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

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_rag_session ON rag_chunks(session_id)")
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS rag_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(())
    }

    fn serialize_embedding(embedding: &[f32]) -> Vec<u8> {
        embedding.iter().flat_map(|f| f.to_le_bytes()).collect()
    }

    fn deserialize_embedding(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect()
    }

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

    fn chunk_start_offset(chunk: &StoredChunk) -> usize {
        chunk
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("start_offset"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize
    }

    fn row_to_chunk(row: &sqlx::sqlite::SqliteRow) -> StoredChunk {
        let metadata_str: String = row.get("metadata");
        let metadata = serde_json::from_str::<Value>(&metadata_str).ok();

        StoredChunk {
            chunk_id: row.get("chunk_id"),
            content: row.get("content"),
            source: row.get("source"),
            session_id: row.get("session_id"),
            metadata,
        }
    }
}

#[async_trait]
impl RagStore for SqliteRagStore {
    async fn insert(&self, chunk: StoredChunk, embedding: Vec<f32>) -> Result<(), ApiError> {
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

    async fn insert_batch(&self, items: Vec<(StoredChunk, Vec<f32>)>) -> Result<(), ApiError> {
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
        Ok(())
    }

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<ChunkSearchResult>, ApiError> {
        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT chunk_id, content, source, session_id, metadata, embedding
                 FROM rag_chunks
                 WHERE session_id = ?1",
            )
            .bind(session_id)
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

        let mut scored: Vec<ChunkSearchResult> = rows
            .iter()
            .filter_map(|row| {
                let embedding_bytes: Vec<u8> = row.get("embedding");
                if embedding_bytes.is_empty() {
                    return None;
                }
                let stored_emb = Self::deserialize_embedding(&embedding_bytes);
                let score = Self::cosine_similarity(query_embedding, &stored_emb);

                Some(ChunkSearchResult {
                    chunk: Self::row_to_chunk(row),
                    score,
                })
            })
            .collect();

        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(limit.max(1));

        Ok(scored)
    }

    async fn text_search(
        &self,
        pattern: &str,
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<StoredChunk>, ApiError> {
        let escaped = format!("%{}%", pattern.trim());
        if escaped == "%%" {
            return Ok(Vec::new());
        }

        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT chunk_id, content, source, session_id, metadata
                 FROM rag_chunks
                 WHERE session_id = ?1 AND content LIKE ?2
                 ORDER BY created_at DESC
                 LIMIT ?3",
            )
            .bind(session_id)
            .bind(&escaped)
            .bind(limit.max(1) as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT chunk_id, content, source, session_id, metadata
                 FROM rag_chunks
                 WHERE content LIKE ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )
            .bind(&escaped)
            .bind(limit.max(1) as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };

        Ok(rows.iter().map(Self::row_to_chunk).collect())
    }

    async fn get_chunk(&self, chunk_id: &str) -> Result<Option<StoredChunk>, ApiError> {
        let row = sqlx::query(
            "SELECT chunk_id, content, source, session_id, metadata
             FROM rag_chunks
             WHERE chunk_id = ?1",
        )
        .bind(chunk_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(row.as_ref().map(Self::row_to_chunk))
    }

    async fn get_chunk_window(
        &self,
        chunk_id: &str,
        max_chars: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<StoredChunk>, ApiError> {
        if max_chars == 0 {
            return Ok(Vec::new());
        }

        let Some(target) = self.get_chunk(chunk_id).await? else {
            return Ok(Vec::new());
        };

        let target_session = session_id.unwrap_or(&target.session_id);

        let rows = sqlx::query(
            "SELECT chunk_id, content, source, session_id, metadata
             FROM rag_chunks
             WHERE session_id = ?1 AND source = ?2",
        )
        .bind(target_session)
        .bind(&target.source)
        .fetch_all(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        let mut chunks: Vec<StoredChunk> = rows.iter().map(Self::row_to_chunk).collect();
        chunks.sort_by_key(Self::chunk_start_offset);

        let Some(target_idx) = chunks
            .iter()
            .position(|chunk| chunk.chunk_id == target.chunk_id)
        else {
            return Ok(vec![target]);
        };

        let mut selected_indices = vec![target_idx];
        let mut total_chars = chunks[target_idx].content.chars().count();

        let mut left = target_idx.checked_sub(1);
        let mut right = target_idx + 1;

        while left.is_some() || right < chunks.len() {
            let mut added = false;

            if let Some(left_idx) = left {
                let chars = chunks[left_idx].content.chars().count();
                if total_chars + chars <= max_chars {
                    selected_indices.push(left_idx);
                    total_chars += chars;
                    added = true;
                }
                left = left_idx.checked_sub(1);
            }

            if right < chunks.len() {
                let chars = chunks[right].content.chars().count();
                if total_chars + chars <= max_chars {
                    selected_indices.push(right);
                    total_chars += chars;
                    added = true;
                }
                right += 1;
            }

            if !added {
                break;
            }
        }

        selected_indices.sort_unstable();
        Ok(selected_indices
            .into_iter()
            .filter_map(|idx| chunks.get(idx).cloned())
            .collect())
    }

    async fn delete_session(&self, session_id: &str) -> Result<usize, ApiError> {
        let result = sqlx::query("DELETE FROM rag_chunks WHERE session_id = ?1")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        Ok(result.rows_affected() as usize)
    }

    async fn clear_session(&self, session_id: &str) -> Result<usize, ApiError> {
        self.delete_session(session_id).await
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
        let count: i64 = if let Some(session_id) = session_id {
            sqlx::query_scalar("SELECT COUNT(*) FROM rag_chunks WHERE session_id = ?1")
                .bind(session_id)
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

    async fn reindex_with_model(&self, embedding_model: &str) -> Result<(), ApiError> {
        sqlx::query("DELETE FROM rag_chunks")
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        sqlx::query(
            "INSERT OR REPLACE INTO rag_meta (key, value, updated_at)
             VALUES ('embedding_model', ?1, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(embedding_model)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

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

    fn make_chunk(
        id: &str,
        content: &str,
        source: &str,
        session: &str,
        start_offset: usize,
    ) -> StoredChunk {
        StoredChunk {
            chunk_id: id.to_string(),
            content: content.to_string(),
            source: source.to_string(),
            session_id: session.to_string(),
            metadata: Some(serde_json::json!({ "start_offset": start_offset })),
        }
    }

    #[tokio::test]
    async fn insert_and_search() {
        let store = test_store().await;

        let chunk = make_chunk("c1", "Hello world", "test", "s1", 0);
        let embedding = vec![1.0, 0.0, 0.0];

        store.insert(chunk, embedding.clone()).await.unwrap();
        assert_eq!(store.count(None).await.unwrap(), 1);

        let results = store.search(&embedding, 10, None).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].chunk.chunk_id, "c1");
        assert!(results[0].score > 0.99);
    }

    #[tokio::test]
    async fn text_search_and_get_chunk() {
        let store = test_store().await;

        store
            .insert(make_chunk("c1", "Rust memory safety", "doc", "s1", 0), vec![1.0])
            .await
            .unwrap();
        store
            .insert(make_chunk("c2", "Python tips", "doc", "s1", 100), vec![1.0])
            .await
            .unwrap();

        let text_results = store.text_search("memory", 10, Some("s1")).await.unwrap();
        assert_eq!(text_results.len(), 1);
        assert_eq!(text_results[0].chunk_id, "c1");

        let chunk = store.get_chunk("c2").await.unwrap().unwrap();
        assert_eq!(chunk.content, "Python tips");
    }

    #[tokio::test]
    async fn get_chunk_window_collects_neighbors_by_offset() {
        let store = test_store().await;

        store
            .insert(make_chunk("c1", "AAAA", "doc", "s1", 0), vec![1.0])
            .await
            .unwrap();
        store
            .insert(make_chunk("c2", "BBBB", "doc", "s1", 10), vec![1.0])
            .await
            .unwrap();
        store
            .insert(make_chunk("c3", "CCCC", "doc", "s1", 20), vec![1.0])
            .await
            .unwrap();

        let window = store
            .get_chunk_window("c2", 12, Some("s1"))
            .await
            .unwrap();

        let ids: Vec<String> = window.into_iter().map(|c| c.chunk_id).collect();
        assert_eq!(ids, vec!["c1", "c2", "c3"]);
    }

    #[tokio::test]
    async fn clear_session_and_reindex_with_model() {
        let store = test_store().await;

        store
            .insert(make_chunk("c1", "data", "doc", "s1", 0), vec![1.0])
            .await
            .unwrap();
        store
            .insert(make_chunk("c2", "data", "doc", "s2", 0), vec![1.0])
            .await
            .unwrap();

        let deleted = store.clear_session("s1").await.unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(store.count(None).await.unwrap(), 1);

        store.reindex_with_model("embed-v2").await.unwrap();
        assert_eq!(store.count(None).await.unwrap(), 0);

        let model: Option<String> = sqlx::query_scalar("SELECT value FROM rag_meta WHERE key = 'embedding_model'")
            .fetch_optional(&store.pool)
            .await
            .unwrap();
        assert_eq!(model.unwrap_or_default(), "embed-v2");
    }
}
