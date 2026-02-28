use std::path::PathBuf;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{QueryBuilder, Row, SqlitePool};

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;
use crate::em_llm::decay::DecayEngine;
use crate::em_llm::ranking::compute_retrieval_score;
use crate::em_llm::types::{DecayConfig, MemoryLayer};

const ENCRYPTION_PREFIX: &str = "ENC:";

#[derive(Debug, Clone)]
pub struct RetrievedMemoryRecord {
    pub id: String,
    pub session_id: String,
    pub content: String,
    pub created_at: String,
    pub semantic_similarity: f64,
    pub score: f64,
    pub strength: f64,
    pub access_count: u32,
    pub last_accessed_at: Option<String>,
    pub memory_layer: MemoryLayer,
}

#[derive(Debug, Clone)]
pub struct MemoryEventRecord {
    pub id: String,
    pub session_id: String,
    pub user_input: String,
    pub assistant_output: String,
    pub content: String,
    pub embedding: Vec<f32>,
    pub created_at: String,
    pub strength: f64,
    pub importance: f64,
    pub access_count: u32,
    pub last_accessed_at: Option<String>,
    pub last_decayed_at: Option<String>,
    pub memory_layer: MemoryLayer,
}

#[derive(Debug, Clone, Default)]
pub struct LayerCounts {
    pub lml: usize,
    pub sml: usize,
}

#[derive(Clone)]
pub struct EmMemoryStore {
    pool: SqlitePool,
    #[allow(dead_code)]
    db_path: PathBuf,
    encryption_key: Option<Key<Aes256Gcm>>,
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

        let store = Self {
            pool,
            db_path,
            encryption_key: None,
        };
        store.init_schema().await?;
        Ok(store)
    }

    pub fn set_encryption_key(&mut self, key_bytes: &[u8]) {
        if key_bytes.len() == 32 {
            self.encryption_key = Some(*Key::<Aes256Gcm>::from_slice(key_bytes));
        } else {
            tracing::warn!("Invalid encryption key length: expected 32 bytes");
        }
    }

    fn encrypt(&self, plaintext: &str) -> Result<String, ApiError> {
        if let Some(key) = &self.encryption_key {
            let cipher = Aes256Gcm::new(key);
            let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
            match cipher.encrypt(&nonce, plaintext.as_bytes()) {
                Ok(ciphertext) => Ok(format!(
                    "{}{}{}",
                    ENCRYPTION_PREFIX,
                    hex::encode(nonce),
                    hex::encode(ciphertext)
                )),
                Err(e) => {
                    tracing::error!("Encryption failed: {}", e);
                    Err(ApiError::internal("Encryption failed"))
                }
            }
        } else {
            Ok(plaintext.to_string())
        }
    }

    fn decrypt(&self, text: &str) -> String {
        if !text.starts_with(ENCRYPTION_PREFIX) {
            return text.to_string();
        }

        if let Some(key) = &self.encryption_key {
            let payload = &text[ENCRYPTION_PREFIX.len()..];
            if payload.len() < 24 {
                // Nonce is 12 bytes = 24 hex chars
                return text.to_string();
            }

            let (nonce_hex, ciphertext_hex) = payload.split_at(24);

            let Ok(nonce_bytes) = hex::decode(nonce_hex) else {
                return text.to_string();
            };
            let Ok(ciphertext_bytes) = hex::decode(ciphertext_hex) else {
                return text.to_string();
            };

            let nonce = Nonce::from_slice(&nonce_bytes);
            let cipher = Aes256Gcm::new(key);

            match cipher.decrypt(nonce, ciphertext_bytes.as_ref()) {
                Ok(plaintext_bytes) => {
                    String::from_utf8(plaintext_bytes).unwrap_or_else(|_| text.to_string())
                }
                Err(_) => {
                    // Decryption failed (wrong key or corrupted)
                    text.to_string()
                }
            }
        } else {
            text.to_string()
        }
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
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
                strength REAL NOT NULL DEFAULT 1.0,
                access_count INTEGER NOT NULL DEFAULT 0,
                last_accessed_at TEXT,
                memory_layer TEXT NOT NULL DEFAULT 'SML'
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        // Backward-compatible migration for existing DB files.
        self.add_column_if_missing(
            "ALTER TABLE episodic_events ADD COLUMN strength REAL NOT NULL DEFAULT 1.0",
        )
        .await?;
        self.add_column_if_missing(
            "ALTER TABLE episodic_events ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
        )
        .await?;
        self.add_column_if_missing("ALTER TABLE episodic_events ADD COLUMN last_accessed_at TEXT")
            .await?;
        self.add_column_if_missing(
            "ALTER TABLE episodic_events ADD COLUMN memory_layer TEXT NOT NULL DEFAULT 'SML'",
        )
        .await?;
        self.add_column_if_missing("ALTER TABLE episodic_events ADD COLUMN last_decayed_at TEXT")
            .await?;
        self.add_column_if_missing(
            "ALTER TABLE episodic_events ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
        )
        .await?;
        self.add_column_if_missing(
            "ALTER TABLE episodic_events ADD COLUMN importance REAL NOT NULL DEFAULT 0.5",
        )
        .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_episodic_events_session_created_at
             ON episodic_events(session_id, created_at)",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_episodic_events_strength
             ON episodic_events(strength)",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(())
    }

    async fn add_column_if_missing(&self, sql: &str) -> Result<(), ApiError> {
        match sqlx::query(sql).execute(&self.pool).await {
            Ok(_) => Ok(()),
            Err(err) if is_duplicate_column_error(&err) => Ok(()),
            Err(err) => Err(ApiError::internal(err)),
        }
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

        let enc_user_input = self.encrypt(user_input)?;
        let enc_assistant_output = self.encrypt(assistant_output)?;
        let enc_content = self.encrypt(content)?;

        sqlx::query(
            "INSERT OR REPLACE INTO episodic_events
                (id, session_id, user_input, assistant_output, content, embedding, strength, access_count, memory_layer)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1.0, 0, 'SML')",
        )
        .bind(id)
        .bind(session_id)
        .bind(enc_user_input)
        .bind(enc_assistant_output)
        .bind(enc_content)
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
        decay_config: &DecayConfig,
    ) -> Result<Vec<RetrievedMemoryRecord>, ApiError> {
        if query_embedding.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT id, session_id, content, embedding, created_at, strength, access_count, last_accessed_at, memory_layer
                 FROM episodic_events
                 WHERE session_id = ?1 AND (is_deleted IS NULL OR is_deleted = 0)",
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT id, session_id, content, embedding, created_at, strength, access_count, last_accessed_at, memory_layer
                 FROM episodic_events
                 WHERE is_deleted IS NULL OR is_deleted = 0",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };

        let now = Utc::now();
        let mut scored = Vec::new();
        for row in rows {
            let embedding_bytes: Vec<u8> = row.get("embedding");
            if embedding_bytes.is_empty() {
                continue;
            }
            let embedding = deserialize_embedding(&embedding_bytes);
            let similarity = cosine_similarity(query_embedding, &embedding);

            let created_at: String = row.get("created_at");
            let layer_raw: String = row
                .try_get("memory_layer")
                .unwrap_or_else(|_| "SML".to_string());
            let memory_layer = parse_memory_layer(&layer_raw);
            let strength: f64 = row.try_get("strength").unwrap_or(1.0);
            let access_count_raw: i64 = row.try_get("access_count").unwrap_or(0);
            let access_count = access_count_raw.max(0) as u32;
            let recency_days = elapsed_days_since(&created_at, now);
            let score = compute_retrieval_score(
                similarity,
                strength,
            );

            let raw_content: String = row.get("content");
            let content = self.decrypt(&raw_content);

            scored.push(RetrievedMemoryRecord {
                id: row.get("id"),
                session_id: row.get("session_id"),
                content,
                created_at,
                semantic_similarity: similarity as f64,
                score,
                strength,
                access_count,
                last_accessed_at: row.try_get("last_accessed_at").unwrap_or(None),
                memory_layer,
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

    pub async fn reinforce_accesses(
        &self,
        records: &mut [RetrievedMemoryRecord],
        decay_config: &DecayConfig,
    ) -> Result<(), ApiError> {
        if records.is_empty() {
            return Ok(());
        }

        let now = Utc::now().to_rfc3339();
        let decay_engine = DecayEngine::new(decay_config.clone());

        for record in records {
            let new_access_count = record.access_count.saturating_add(1);
            let new_strength = decay_engine.reinforce(record.strength, new_access_count);
            // Importance semantic signal must use cosine similarity, not ranked score.
            let similarity = record.semantic_similarity.clamp(0.0, 1.0);
            let created_at = &record.created_at;
            let age_days = elapsed_days_since(created_at, Utc::now());
            let new_importance =
                decay_engine.importance_score(similarity, new_access_count, age_days);

            sqlx::query(
                "UPDATE episodic_events
                 SET access_count = ?2,
                     last_accessed_at = ?3,
                     last_decayed_at = ?3,
                     strength = ?4,
                     importance = ?5
                 WHERE id = ?1",
            )
            .bind(&record.id)
            .bind(new_access_count as i64)
            .bind(&now)
            .bind(new_strength)
            .bind(new_importance)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

            record.access_count = new_access_count;
            record.strength = new_strength;
            record.last_accessed_at = Some(now.clone());
        }

        Ok(())
    }

    pub async fn get_all_events_with_metadata(
        &self,
        session_id: Option<&str>,
    ) -> Result<Vec<MemoryEventRecord>, ApiError> {
        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT id, session_id, user_input, assistant_output, content, embedding, created_at,
                        strength, importance, access_count, last_accessed_at, last_decayed_at, memory_layer
                 FROM episodic_events
                 WHERE session_id = ?1 AND (is_deleted IS NULL OR is_deleted = 0)
                 ORDER BY created_at DESC",
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT id, session_id, user_input, assistant_output, content, embedding, created_at,
                        strength, importance, access_count, last_accessed_at, last_decayed_at, memory_layer
                 FROM episodic_events
                 WHERE is_deleted IS NULL OR is_deleted = 0
                 ORDER BY created_at DESC",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let embedding_bytes: Vec<u8> = row.get("embedding");
            if embedding_bytes.is_empty() {
                continue;
            }

            let user_input_raw: String = row.get("user_input");
            let assistant_output_raw: String = row.get("assistant_output");
            let content_raw: String = row.get("content");
            let layer_raw: String = row
                .try_get("memory_layer")
                .unwrap_or_else(|_| "SML".to_string());
            let access_count_raw: i64 = row.try_get("access_count").unwrap_or(0);

            out.push(MemoryEventRecord {
                id: row.get("id"),
                session_id: row.get("session_id"),
                user_input: self.decrypt(&user_input_raw),
                assistant_output: self.decrypt(&assistant_output_raw),
                content: self.decrypt(&content_raw),
                embedding: deserialize_embedding(&embedding_bytes),
                created_at: row.get("created_at"),
                strength: row.try_get("strength").unwrap_or(1.0),
                importance: row.try_get("importance").unwrap_or(0.5),
                access_count: access_count_raw.max(0) as u32,
                last_accessed_at: row.try_get("last_accessed_at").unwrap_or(None),
                last_decayed_at: row.try_get("last_decayed_at").unwrap_or(None),
                memory_layer: parse_memory_layer(&layer_raw),
            });
        }

        Ok(out)
    }

    pub async fn update_memory_strength(&self, id: &str, strength: f64) -> Result<(), ApiError> {
        sqlx::query("UPDATE episodic_events SET strength = ?2 WHERE id = ?1")
            .bind(id)
            .bind(strength.clamp(0.0, 1.0))
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        Ok(())
    }

    /// Update both strength and the decay anchor timestamp in a single write.
    /// This ensures that the next decay cycle only computes the delta since this update.
    pub async fn update_memory_strength_and_decay_anchor(
        &self,
        id: &str,
        strength: f64,
        decay_anchor: &str,
    ) -> Result<(), ApiError> {
        sqlx::query("UPDATE episodic_events SET strength = ?2, last_decayed_at = ?3 WHERE id = ?1")
            .bind(id)
            .bind(strength.clamp(0.0, 1.0))
            .bind(decay_anchor)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        Ok(())
    }

    pub async fn update_memory_layer(&self, id: &str, layer: MemoryLayer) -> Result<(), ApiError> {
        sqlx::query("UPDATE episodic_events SET memory_layer = ?2 WHERE id = ?1")
            .bind(id)
            .bind(layer.as_str())
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        Ok(())
    }

    pub async fn prune_weak_memories(
        &self,
        threshold: f64,
        session_id: Option<&str>,
    ) -> Result<usize, ApiError> {
        let result = if let Some(sid) = session_id {
            sqlx::query(
                "UPDATE episodic_events SET is_deleted = 1 WHERE strength < ?1 AND session_id = ?2 AND (is_deleted IS NULL OR is_deleted = 0)",
            )
            .bind(threshold.clamp(0.0, 1.0))
            .bind(sid)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "UPDATE episodic_events SET is_deleted = 1 WHERE strength < ?1 AND (is_deleted IS NULL OR is_deleted = 0)",
            )
            .bind(threshold.clamp(0.0, 1.0))
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };
        Ok(result.rows_affected() as usize)
    }

    pub async fn delete_events_by_ids(&self, ids: &[String]) -> Result<usize, ApiError> {
        if ids.is_empty() {
            return Ok(0);
        }

        let mut qb = QueryBuilder::<sqlx::Sqlite>::new(
            "UPDATE episodic_events SET is_deleted = 1 WHERE id IN (",
        );
        let mut separated = qb.separated(", ");
        for id in ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");

        let result = qb
            .build()
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        Ok(result.rows_affected() as usize)
    }

    pub async fn count_events(&self, session_id: Option<&str>) -> Result<usize, ApiError> {
        let count: i64 = if let Some(session_id) = session_id {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM episodic_events WHERE session_id = ?1 AND (is_deleted IS NULL OR is_deleted = 0)",
            )
            .bind(session_id)
            .fetch_one(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM episodic_events WHERE is_deleted IS NULL OR is_deleted = 0",
            )
            .fetch_one(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };

        Ok(count as usize)
    }

    pub async fn count_by_layer(&self) -> Result<LayerCounts, ApiError> {
        let rows = sqlx::query(
            "SELECT memory_layer, COUNT(*) as c
             FROM episodic_events
             WHERE is_deleted IS NULL OR is_deleted = 0
             GROUP BY memory_layer",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        let mut counts = LayerCounts::default();
        for row in rows {
            let layer: String = row
                .try_get("memory_layer")
                .unwrap_or_else(|_| "SML".to_string());
            let count: i64 = row.try_get("c").unwrap_or(0);
            match parse_memory_layer(&layer) {
                MemoryLayer::LML => counts.lml = count.max(0) as usize,
                MemoryLayer::SML => counts.sml = count.max(0) as usize,
            }
        }

        Ok(counts)
    }

    pub async fn average_strength(&self) -> Result<f64, ApiError> {
        let avg: Option<f64> = sqlx::query_scalar(
            "SELECT AVG(strength) FROM episodic_events WHERE is_deleted IS NULL OR is_deleted = 0",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(avg.unwrap_or(0.0))
    }
}

fn is_duplicate_column_error(err: &sqlx::Error) -> bool {
    err.to_string()
        .to_ascii_lowercase()
        .contains("duplicate column name")
}

fn parse_memory_layer(raw: &str) -> MemoryLayer {
    if raw.eq_ignore_ascii_case("LML") {
        MemoryLayer::LML
    } else {
        MemoryLayer::SML
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

fn elapsed_days_since(timestamp: &str, now: DateTime<Utc>) -> f64 {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|dt| now.signed_duration_since(dt.with_timezone(&Utc)))
        .map(|dur| (dur.num_seconds().max(0) as f64) / 86_400.0)
        .unwrap_or(0.0)
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
            .retrieve_similar(&[1.0, 0.0, 0.0], Some("s1"), 5, &DecayConfig::default())
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "e1");
        assert!(results[0].score > 0.5);
        assert_eq!(results[0].memory_layer, MemoryLayer::SML);
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

    #[tokio::test]
    async fn encryption_test() {
        let mut store = test_store().await;
        // Set a dummy key (32 bytes)
        let key = [42u8; 32];
        store.set_encryption_key(&key);

        let content = "This is a secret message";

        store
            .insert_event(
                "enc-1",
                "s1",
                "secret input",
                "secret output",
                content,
                &[0.5, 0.5, 0.0],
            )
            .await
            .unwrap();

        // Retrieve and check if decrypted
        let results = store
            .retrieve_similar(&[0.5, 0.5, 0.0], Some("s1"), 5, &DecayConfig::default())
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, content);

        // Re-open store without key
        let db_path = store.db_path.clone();
        let store_no_key = EmMemoryStore::with_path(db_path).await.unwrap();

        let results_enc = store_no_key
            .retrieve_similar(&[0.5, 0.5, 0.0], Some("s1"), 5, &DecayConfig::default())
            .await
            .unwrap();

        assert_eq!(results_enc.len(), 1);
        assert_ne!(results_enc[0].content, content);
        assert!(results_enc[0].content.starts_with(ENCRYPTION_PREFIX));
    }

    #[tokio::test]
    async fn store_migration_adds_columns() {
        let tmp = std::env::temp_dir().join(format!(
            "tepora-em-memory-migration-test-{}.db",
            uuid::Uuid::new_v4()
        ));

        let options = SqliteConnectOptions::new()
            .filename(&tmp)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE episodic_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                user_input TEXT NOT NULL,
                assistant_output TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        drop(pool);

        let store = EmMemoryStore::with_path(tmp).await.unwrap();
        let columns: Vec<String> = sqlx::query("PRAGMA table_info(episodic_events)")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect();

        assert!(columns.contains(&"strength".to_string()));
        assert!(columns.contains(&"access_count".to_string()));
        assert!(columns.contains(&"last_accessed_at".to_string()));
        assert!(columns.contains(&"memory_layer".to_string()));
    }

    #[tokio::test]
    async fn retrieve_with_decay_ranking() {
        let store = test_store().await;

        store
            .insert_event("weak", "s1", "u", "a", "weak content", &[1.0, 0.0])
            .await
            .unwrap();
        store
            .insert_event("strong", "s1", "u", "a", "strong content", &[1.0, 0.0])
            .await
            .unwrap();

        store.update_memory_strength("weak", 0.2).await.unwrap();
        store.update_memory_strength("strong", 0.9).await.unwrap();

        let results = store
            .retrieve_similar(&[1.0, 0.0], Some("s1"), 2, &DecayConfig::default())
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "strong");
        assert!(results[0].score > results[1].score);
    }

    #[tokio::test]
    async fn reinforce_accesses_uses_similarity_and_updates_decay_anchor() {
        let store = test_store().await;

        store
            .insert_event("e1", "s1", "u", "a", "content", &[1.0, 0.0])
            .await
            .unwrap();
        store.update_memory_strength("e1", 0.1).await.unwrap();

        let mut records = store
            .retrieve_similar(&[1.0, 0.0], Some("s1"), 1, &DecayConfig::default())
            .await
            .unwrap();
        assert_eq!(records.len(), 1);

        store
            .reinforce_accesses(&mut records, &DecayConfig::default())
            .await
            .unwrap();

        let events = store
            .get_all_events_with_metadata(Some("s1"))
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        let event = &events[0];

        // If ranked score were used instead of cosine, this would stay around ~0.3.
        assert!(event.importance > 0.6);
        assert!(event.last_decayed_at.is_some());
        assert_eq!(event.last_decayed_at, event.last_accessed_at);
    }
}
