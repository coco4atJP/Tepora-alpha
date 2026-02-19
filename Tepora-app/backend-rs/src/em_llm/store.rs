use std::path::PathBuf;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

use crate::core::config::AppPaths;
use crate::core::errors::ApiError;

const ENCRYPTION_PREFIX: &str = "ENC:";

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
                Ok(ciphertext) => {
                    Ok(format!("{}{}{}", ENCRYPTION_PREFIX, hex::encode(nonce), hex::encode(ciphertext)))
                }
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
            if payload.len() < 24 { // Nonce is 12 bytes = 24 hex chars
                return text.to_string();
            }

            let (nonce_hex, ciphertext_hex) = payload.split_at(24);
            
            let Ok(nonce_bytes) = hex::decode(nonce_hex) else { return text.to_string() };
            let Ok(ciphertext_bytes) = hex::decode(ciphertext_hex) else { return text.to_string() };
            
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
        
        let enc_user_input = self.encrypt(user_input)?;
        let enc_assistant_output = self.encrypt(assistant_output)?;
        let enc_content = self.encrypt(content)?;

        sqlx::query(
            "INSERT OR REPLACE INTO episodic_events
                (id, session_id, user_input, assistant_output, content, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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

            let raw_content: String = row.get("content");
            let content = self.decrypt(&raw_content);

            scored.push(RetrievedMemoryRecord {
                id: row.get("id"),
                session_id: row.get("session_id"),
                content,
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
            .retrieve_similar(&[0.5, 0.5, 0.0], Some("s1"), 5)
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, content);

        // Verify raw data is encrypted by peeking at DB directly (simulated by checking raw text search if we had it, or by checking encryption prefix property via a new test helper or just trust the code)
        // Since we don't have a raw retrieval method exposed, we can verify encryption by *removing* the key and retrieving.
        
        // Re-open store without key
        let db_path = store.db_path.clone();
        let store_no_key = EmMemoryStore::with_path(db_path).await.unwrap();
        
        let results_enc = store_no_key
            .retrieve_similar(&[0.5, 0.5, 0.0], Some("s1"), 5)
            .await
            .unwrap();
            
        assert_eq!(results_enc.len(), 1);
        assert_ne!(results_enc[0].content, content);
        assert!(results_enc[0].content.starts_with(ENCRYPTION_PREFIX));
    }
}
