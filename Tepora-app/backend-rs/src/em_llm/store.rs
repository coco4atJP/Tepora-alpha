use std::path::PathBuf;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;

#[derive(Debug, Clone)]
pub struct RetrievedMemoryRecord {
    pub id: String,
    pub session_id: String,
    pub content: String,
    pub created_at: String,
    pub score: f32,
}

#[derive(Clone)]
pub struct EmMemoryStore {
    pool: SqlitePool,
    #[allow(dead_code)]
    db_path: PathBuf,
}

impl EmMemoryStore {
    pub async fn new(paths: &AppPaths) -> Result<Self, ApiError> {
        let db_path = paths.user_data_dir.join("em_memory.db");
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
            "CREATE TABLE IF NOT EXISTS episodic_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                user_input TEXT NOT NULL,
                assistant_output TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_episodic_events_session_created_at
             ON episodic_events(session_id, created_at)",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(())
    }

    pub async fn insert_event(
        &self,
        id: &str,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        content: &str,
        embedding: &[f32],
    ) -> Result<(), ApiError> {
        let blob = serialize_embedding(embedding);

        sqlx::query(
            "INSERT OR REPLACE INTO episodic_events
                (id, session_id, user_input, assistant_output, content, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(id)
        .bind(session_id)
        .bind(user_input)
        .bind(assistant_output)
        .bind(content)
        .bind(blob)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(())
    }

    pub async fn retrieve_similar(
        &self,
        query_embedding: &[f32],
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RetrievedMemoryRecord>, ApiError> {
        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT id, session_id, content, embedding, created_at
                 FROM episodic_events
                 WHERE session_id = ?1",
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT id, session_id, content, embedding, created_at
                 FROM episodic_events",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };

        let mut scored = Vec::new();
        for row in rows {
            let embedding_bytes: Vec<u8> = row.get("embedding");
            if embedding_bytes.is_empty() {
                continue;
            }
            let embedding = deserialize_embedding(&embedding_bytes);
            let score = cosine_similarity(query_embedding, &embedding);

            scored.push(RetrievedMemoryRecord {
                id: row.get("id"),
                session_id: row.get("session_id"),
                content: row.get("content"),
                created_at: row.get("created_at"),
                score,
            });
        }

        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.created_at.cmp(&a.created_at))
        });
        scored.truncate(limit);

        Ok(scored)
    }

    pub async fn count_events(&self, session_id: Option<&str>) -> Result<usize, ApiError> {
        let count: i64 = if let Some(session_id) = session_id {
            sqlx::query_scalar("SELECT COUNT(*) FROM episodic_events WHERE session_id = ?1")
                .bind(session_id)
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
        } else {
            sqlx::query_scalar("SELECT COUNT(*) FROM episodic_events")
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
        };

        Ok(count as usize)
    }
}

fn serialize_embedding(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|v| v.to_le_bytes()).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_store() -> EmMemoryStore {
        let tmp =
            std::env::temp_dir().join(format!("tepora-em-memory-test-{}.db", uuid::Uuid::new_v4()));
        EmMemoryStore::with_path(tmp).await.unwrap()
    }

    #[tokio::test]
    async fn insert_and_retrieve() {
        let store = test_store().await;

        store
            .insert_event(
                "e1",
                "s1",
                "user asks sky",
                "assistant replies blue",
                "User: user asks sky\nAssistant: assistant replies blue",
                &[1.0, 0.0, 0.0],
            )
            .await
            .unwrap();

        let results = store
            .retrieve_similar(&[1.0, 0.0, 0.0], Some("s1"), 5)
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "e1");
        assert!(results[0].score > 0.99);
    }

    #[tokio::test]
    async fn persistence_reload() {
        let tmp = std::env::temp_dir().join(format!(
            "tepora-em-memory-persist-test-{}.db",
            uuid::Uuid::new_v4()
        ));

        {
            let store = EmMemoryStore::with_path(tmp.clone()).await.unwrap();
            store
                .insert_event("persist-1", "s1", "u", "a", "content", &[0.1, 0.2, 0.3])
                .await
                .unwrap();
            assert_eq!(store.count_events(None).await.unwrap(), 1);
        }

        let reloaded = EmMemoryStore::with_path(tmp).await.unwrap();
        assert_eq!(reloaded.count_events(None).await.unwrap(), 1);
    }
}
