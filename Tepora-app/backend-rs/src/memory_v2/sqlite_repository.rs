#![allow(dead_code)]
//! SQLite implementation of `MemoryRepository`.
//!
//! Uses the same `em_memory.db` file as the existing `EmMemoryStore`, adding
//! the new `memory_events`, `memory_edges`, and `memory_compaction_*` tables
//! alongside the legacy `episodic_events` table.

use std::path::PathBuf;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

use crate::core::errors::ApiError;

use super::repository::{MemoryRepository, ScoredEvent};
use super::types::{
    CompactionJob, CompactionMember, CompactionStatus, LayerCounts, MemoryEdge, MemoryEdgeType,
    MemoryEvent, MemoryLayer, MemoryScope, ScopeStats, SourceRole,
};

// ---------------------------------------------------------------------------
// Helpers (shared with em_llm::store — could be extracted later)
// ---------------------------------------------------------------------------

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

fn parse_iso_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| {
            // Fallback: try SQLite's `STRFTIME` format which omits timezone
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.fZ")
                .map(|naive| naive.and_utc())
                .unwrap_or_else(|_| Utc::now())
        })
}

fn parse_optional_dt(s: Option<String>) -> Option<DateTime<Utc>> {
    s.map(|v| parse_iso_dt(&v))
}

fn parse_memory_layer(raw: &str) -> MemoryLayer {
    if raw.eq_ignore_ascii_case("LML") {
        MemoryLayer::LML
    } else {
        MemoryLayer::SML
    }
}

const ENCRYPTION_PREFIX: &str = "ENC:";

// ---------------------------------------------------------------------------
// SqliteMemoryRepository
// ---------------------------------------------------------------------------

/// SQLite-backed implementation of `MemoryRepository`.
#[derive(Clone)]
pub struct SqliteMemoryRepository {
    pool: SqlitePool,
    #[allow(dead_code)]
    db_path: PathBuf,
    encryption_key: Option<Key<Aes256Gcm>>,
}

impl std::fmt::Debug for SqliteMemoryRepository {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteMemoryRepository")
            .field("db_path", &self.db_path)
            .finish()
    }
}

impl SqliteMemoryRepository {
    /// Open (or create) the database at the given path and initialise schema.
    pub async fn new(db_path: PathBuf) -> Result<Self, ApiError> {
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

        let repo = Self {
            pool,
            db_path,
            encryption_key: None,
        };
        repo.init_schema().await?;
        Ok(repo)
    }

    /// Set the encryption key for content encryption/decryption.
    pub fn set_encryption_key(&mut self, key_bytes: &[u8]) {
        if key_bytes.len() == 32 {
            self.encryption_key = Some(*Key::<Aes256Gcm>::from_slice(key_bytes));
        } else {
            tracing::warn!("SqliteMemoryRepository: Invalid encryption key length: expected 32 bytes");
        }
    }

    fn encrypt(&self, plaintext: &str) -> String {
        if let Some(key) = &self.encryption_key {
            let cipher = Aes256Gcm::new(key);
            let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
            match cipher.encrypt(&nonce, plaintext.as_bytes()) {
                Ok(ciphertext) => format!(
                    "{}{}{}",
                    ENCRYPTION_PREFIX,
                    hex::encode(nonce),
                    hex::encode(ciphertext)
                ),
                Err(e) => {
                    tracing::error!("MemoryV2 encryption failed: {}", e);
                    plaintext.to_string()
                }
            }
        } else {
            plaintext.to_string()
        }
    }

    fn decrypt(&self, text: &str) -> String {
        if !text.starts_with(ENCRYPTION_PREFIX) {
            return text.to_string();
        }

        if let Some(key) = &self.encryption_key {
            let payload = &text[ENCRYPTION_PREFIX.len()..];
            if payload.len() < 24 {
                return text.to_string();
            }

            let (nonce_hex, ciphertext_hex) = payload.split_at(24);
            let Ok(nonce_bytes) = hex::decode(nonce_hex) else {
                return text.to_string();
            };
            let Ok(ciphertext_bytes) = hex::decode(ciphertext_hex) else {
                return text.to_string();
            };

            let cipher = Aes256Gcm::new(key);
            let nonce = Nonce::from_slice(&nonce_bytes);
            match cipher.decrypt(nonce, ciphertext_bytes.as_ref()) {
                Ok(plaintext) => String::from_utf8(plaintext).unwrap_or_else(|_| text.to_string()),
                Err(_) => text.to_string(),
            }
        } else {
            text.to_string()
        }
    }

    /// Schema initialisation — idempotent (CREATE IF NOT EXISTS).
    async fn init_schema(&self) -> Result<(), ApiError> {
        // --- memory_events ---
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS memory_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                episode_id TEXT NOT NULL,
                event_seq INTEGER NOT NULL,
                source_turn_id TEXT,
                source_role TEXT,
                content TEXT NOT NULL,
                summary TEXT,
                embedding BLOB NOT NULL,
                surprise_mean REAL,
                surprise_max REAL,
                importance REAL NOT NULL DEFAULT 0.5,
                strength REAL NOT NULL DEFAULT 1.0,
                memory_layer TEXT NOT NULL DEFAULT 'SML',
                access_count INTEGER NOT NULL DEFAULT 0,
                last_accessed_at TEXT,
                decay_anchor_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
                is_deleted INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        // --- memory_edges ---
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS memory_edges (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                from_event_id TEXT NOT NULL,
                to_event_id TEXT NOT NULL,
                edge_type TEXT NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0,
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        // --- memory_compaction_jobs ---
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS memory_compaction_jobs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                status TEXT NOT NULL,
                scanned_events INTEGER NOT NULL DEFAULT 0,
                merged_groups INTEGER NOT NULL DEFAULT 0,
                replaced_events INTEGER NOT NULL DEFAULT 0,
                created_events INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
                finished_at TEXT
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        // --- memory_compaction_members ---
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS memory_compaction_members (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                original_event_id TEXT NOT NULL,
                new_event_id TEXT NOT NULL
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        // --- Indices (§6.2) ---
        for ddl in [
            "CREATE INDEX IF NOT EXISTS idx_me_session_scope_created
                ON memory_events(session_id, scope, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_me_session_scope_strength
                ON memory_events(session_id, scope, strength DESC)",
            "CREATE INDEX IF NOT EXISTS idx_me_session_scope_layer_strength
                ON memory_events(session_id, scope, memory_layer, strength DESC)",
            "CREATE INDEX IF NOT EXISTS idx_medge_from
                ON memory_edges(session_id, from_event_id)",
            "CREATE INDEX IF NOT EXISTS idx_medge_to
                ON memory_edges(session_id, to_event_id)",
        ] {
            sqlx::query(ddl)
                .execute(&self.pool)
                .await
                .map_err(ApiError::internal)?;
        }

        Ok(())
    }

    fn decrypt_static(key: &Option<Key<Aes256Gcm>>, text: &str) -> String {
        if !text.starts_with(ENCRYPTION_PREFIX) {
            return text.to_string();
        }
        let Some(key) = key else {
            return text.to_string();
        };
        let payload = &text[ENCRYPTION_PREFIX.len()..];
        if payload.len() < 24 {
            return text.to_string();
        }
        let (nonce_hex, ciphertext_hex) = payload.split_at(24);
        let Ok(nonce_bytes) = hex::decode(nonce_hex) else {
            return text.to_string();
        };
        let Ok(ciphertext_bytes) = hex::decode(ciphertext_hex) else {
            return text.to_string();
        };
        let cipher = Aes256Gcm::new(key);
        let nonce = Nonce::from_slice(&nonce_bytes);
        match cipher.decrypt(nonce, ciphertext_bytes.as_ref()) {
            Ok(plaintext) => String::from_utf8(plaintext).unwrap_or_else(|_| text.to_string()),
            Err(_) => text.to_string(),
        }
    }

    // --- internal row mapper ---

    fn row_to_event(row: &sqlx::sqlite::SqliteRow, enc_key: &Option<Key<Aes256Gcm>>) -> MemoryEvent {
        let embedding_bytes: Vec<u8> = row.get("embedding");
        let layer_raw: String = row
            .try_get("memory_layer")
            .unwrap_or_else(|_| "SML".to_string());
        let scope_raw: String = row.get("scope");
        let source_role_raw: Option<String> = row.try_get("source_role").unwrap_or(None);
        let access_count_raw: i64 = row.try_get("access_count").unwrap_or(0);
        let is_deleted_raw: i64 = row.try_get("is_deleted").unwrap_or(0);

        let created_at: String = row.get("created_at");
        let updated_at: String = row.get("updated_at");
        let decay_anchor_at: String = row.get("decay_anchor_at");
        let last_accessed_at: Option<String> = row.try_get("last_accessed_at").unwrap_or(None);

        MemoryEvent {
            id: row.get("id"),
            session_id: row.get("session_id"),
            scope: std::str::FromStr::from_str(&scope_raw).unwrap_or_default(),
            episode_id: row.get("episode_id"),
            event_seq: row.get::<i64, _>("event_seq").max(0) as u32,
            source_turn_id: row.try_get("source_turn_id").unwrap_or(None),
            source_role: source_role_raw.map(|s| SourceRole::parse(&s)),
            content: Self::decrypt_static(enc_key, &row.get::<String, _>("content")),
            summary: row.try_get("summary").unwrap_or(None),
            embedding: deserialize_embedding(&embedding_bytes),
            surprise_mean: row.try_get("surprise_mean").unwrap_or(None),
            surprise_max: row.try_get("surprise_max").unwrap_or(None),
            importance: row.try_get("importance").unwrap_or(0.5),
            strength: row.try_get("strength").unwrap_or(1.0),
            layer: parse_memory_layer(&layer_raw),
            access_count: access_count_raw.max(0) as u32,
            last_accessed_at: parse_optional_dt(last_accessed_at),
            decay_anchor_at: parse_iso_dt(&decay_anchor_at),
            created_at: parse_iso_dt(&created_at),
            updated_at: parse_iso_dt(&updated_at),
            is_deleted: is_deleted_raw != 0,
        }
    }

    fn row_to_edge(row: &sqlx::sqlite::SqliteRow) -> MemoryEdge {
        let edge_type_raw: String = row.get("edge_type");
        let created_at: String = row.get("created_at");
        MemoryEdge {
            id: row.get("id"),
            session_id: row.get("session_id"),
            from_event_id: row.get("from_event_id"),
            to_event_id: row.get("to_event_id"),
            edge_type: MemoryEdgeType::parse(&edge_type_raw),
            weight: row.try_get("weight").unwrap_or(1.0),
            created_at: parse_iso_dt(&created_at),
        }
    }

    fn row_to_compaction_job(row: &sqlx::sqlite::SqliteRow) -> CompactionJob {
        let scope_raw: String = row.get("scope");
        let status_raw: String = row.get("status");
        let created_at: String = row.get("created_at");
        let finished_at: Option<String> = row.try_get("finished_at").unwrap_or(None);
        CompactionJob {
            id: row.get("id"),
            session_id: row.try_get("session_id").unwrap_or_default(),
            scope: std::str::FromStr::from_str(&scope_raw).unwrap_or_default(),
            status: std::str::FromStr::from_str(&status_raw).unwrap_or(CompactionStatus::Queued),
            scanned_events: row
                .try_get::<i64, _>("scanned_events")
                .unwrap_or(0)
                .max(0) as usize,
            merged_groups: row.get::<i64, _>("merged_groups").max(0) as usize,
            replaced_events: row.get::<i64, _>("replaced_events").max(0) as usize,
            created_events: row.get::<i64, _>("created_events").max(0) as usize,
            created_at: parse_iso_dt(&created_at),
            finished_at: parse_optional_dt(finished_at),
        }
    }
}

// ---------------------------------------------------------------------------
// MemoryRepository impl
// ---------------------------------------------------------------------------

#[async_trait]
impl MemoryRepository for SqliteMemoryRepository {
    // ===== Events =====

    async fn insert_event(&self, event: &MemoryEvent) -> Result<(), ApiError> {
        let blob = serialize_embedding(&event.embedding);
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT OR REPLACE INTO memory_events
                (id, session_id, scope, episode_id, event_seq, source_turn_id, source_role,
                 content, summary, embedding, surprise_mean, surprise_max,
                 importance, strength, memory_layer, access_count, last_accessed_at,
                 decay_anchor_at, created_at, updated_at, is_deleted)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
        )
        .bind(&event.id)
        .bind(&event.session_id)
        .bind(event.scope.as_str())
        .bind(&event.episode_id)
        .bind(event.event_seq as i64)
        .bind(&event.source_turn_id)
        .bind(event.source_role.map(|r| r.as_str()))
        .bind(self.encrypt(&event.content))
        .bind(&event.summary)
        .bind(&blob)
        .bind(event.surprise_mean)
        .bind(event.surprise_max)
        .bind(event.importance)
        .bind(event.strength)
        .bind(event.layer.as_str())
        .bind(event.access_count as i64)
        .bind(event.last_accessed_at.map(|dt| dt.to_rfc3339()))
        .bind(event.decay_anchor_at.to_rfc3339())
        .bind(event.created_at.to_rfc3339())
        .bind(&now) // updated_at
        .bind(event.is_deleted as i64)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(())
    }

    async fn insert_events(&self, events: &[MemoryEvent]) -> Result<(), ApiError> {
        for event in events {
            self.insert_event(event).await?;
        }
        Ok(())
    }

    async fn get_event(&self, id: &str) -> Result<Option<MemoryEvent>, ApiError> {
        let row = sqlx::query(
            "SELECT * FROM memory_events WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(row.as_ref().map(|r| Self::row_to_event(r, &self.encryption_key)))
    }

    async fn get_events_by_scope(
        &self,
        session_id: &str,
        scope: MemoryScope,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<MemoryEvent>, ApiError> {
        let rows = sqlx::query(
            "SELECT * FROM memory_events
             WHERE session_id = ?1 AND scope = ?2 AND is_deleted = 0
             ORDER BY created_at DESC
             LIMIT ?3 OFFSET ?4",
        )
        .bind(session_id)
        .bind(scope.as_str())
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        let enc_key = &self.encryption_key;
        Ok(rows.iter().map(|r| Self::row_to_event(r, enc_key)).collect())
    }

    async fn retrieve_similar(
        &self,
        session_id: &str,
        scope: Option<MemoryScope>,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<ScoredEvent>, ApiError> {
        if query_embedding.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let rows = if let Some(scope) = scope {
            sqlx::query(
                "SELECT * FROM memory_events
                 WHERE session_id = ?1 AND scope = ?2 AND is_deleted = 0",
            )
            .bind(session_id)
            .bind(scope.as_str())
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT * FROM memory_events
                 WHERE session_id = ?1 AND is_deleted = 0",
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };

        let mut scored: Vec<ScoredEvent> = Vec::with_capacity(rows.len());
        for row in &rows {
            let event = Self::row_to_event(row, &self.encryption_key);
            if event.embedding.is_empty() {
                continue;
            }
            let sim = cosine_similarity(query_embedding, &event.embedding);
            scored.push(ScoredEvent {
                event,
                score: sim as f64,
            });
        }

        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(limit);

        Ok(scored)
    }

    async fn update_strength(&self, id: &str, strength: f64) -> Result<(), ApiError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE memory_events SET strength = ?2, updated_at = ?3 WHERE id = ?1",
        )
        .bind(id)
        .bind(strength.clamp(0.0, 1.0))
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn update_strength_and_anchor(
        &self,
        id: &str,
        strength: f64,
        anchor_time_rfc3339: &str,
    ) -> Result<(), ApiError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE memory_events SET strength = ?2, decay_anchor_at = ?3, updated_at = ?4 WHERE id = ?1",
        )
        .bind(id)
        .bind(strength.clamp(0.0, 1.0))
        .bind(anchor_time_rfc3339)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn update_layer(&self, id: &str, layer: MemoryLayer) -> Result<(), ApiError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE memory_events SET memory_layer = ?2, updated_at = ?3 WHERE id = ?1",
        )
        .bind(id)
        .bind(layer.as_str())
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn update_importance(&self, id: &str, importance: f64) -> Result<(), ApiError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE memory_events SET importance = ?2, updated_at = ?3 WHERE id = ?1",
        )
        .bind(id)
        .bind(importance.clamp(0.0, 1.0))
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn record_access(
        &self,
        id: &str,
        new_strength: f64,
    ) -> Result<(), ApiError> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE memory_events
             SET access_count = access_count + 1,
                 last_accessed_at = ?2,
                 decay_anchor_at = ?2,
                 strength = ?3,
                 updated_at = ?2
             WHERE id = ?1",
        )
        .bind(id)
        .bind(&now)
        .bind(new_strength.clamp(0.0, 1.0))
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn soft_delete_events(&self, ids: &[String]) -> Result<usize, ApiError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let now = Utc::now().to_rfc3339();
        let mut total = 0usize;
        // Process in smaller batches to avoid SQLite variable limit.
        for chunk in ids.chunks(500) {
            let placeholders: Vec<String> = chunk.iter().enumerate().map(|(i, _)| format!("?{}", i + 2)).collect();
            let sql = format!(
                "UPDATE memory_events SET is_deleted = 1, updated_at = ?1 WHERE id IN ({})",
                placeholders.join(", ")
            );
            let mut query = sqlx::query(&sql).bind(&now);
            for id in chunk {
                query = query.bind(id);
            }
            let result = query.execute(&self.pool).await.map_err(ApiError::internal)?;
            total += result.rows_affected() as usize;
        }
        Ok(total)
    }

    async fn get_all_events(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<Vec<MemoryEvent>, ApiError> {
        let rows = match (session_id, scope) {
            (Some(sid), Some(sc)) => {
                sqlx::query(
                    "SELECT * FROM memory_events WHERE session_id = ?1 AND scope = ?2 AND is_deleted = 0 ORDER BY created_at DESC",
                )
                .bind(sid)
                .bind(sc.as_str())
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (Some(sid), None) => {
                sqlx::query(
                    "SELECT * FROM memory_events WHERE session_id = ?1 AND is_deleted = 0 ORDER BY created_at DESC",
                )
                .bind(sid)
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, Some(sc)) => {
                sqlx::query(
                    "SELECT * FROM memory_events WHERE scope = ?1 AND is_deleted = 0 ORDER BY created_at DESC",
                )
                .bind(sc.as_str())
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, None) => {
                sqlx::query(
                    "SELECT * FROM memory_events WHERE is_deleted = 0 ORDER BY created_at DESC",
                )
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
        };

        let enc_key = &self.encryption_key;
        Ok(rows.iter().map(|r| Self::row_to_event(r, enc_key)).collect())
    }

    // ===== Aggregates =====

    async fn count_events(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<usize, ApiError> {
        let count: i64 = match (session_id, scope) {
            (Some(sid), Some(sc)) => {
                sqlx::query_scalar(
                    "SELECT COUNT(*) FROM memory_events WHERE session_id = ?1 AND scope = ?2 AND is_deleted = 0",
                )
                .bind(sid)
                .bind(sc.as_str())
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (Some(sid), None) => {
                sqlx::query_scalar(
                    "SELECT COUNT(*) FROM memory_events WHERE session_id = ?1 AND is_deleted = 0",
                )
                .bind(sid)
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, Some(sc)) => {
                sqlx::query_scalar(
                    "SELECT COUNT(*) FROM memory_events WHERE scope = ?1 AND is_deleted = 0",
                )
                .bind(sc.as_str())
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, None) => {
                sqlx::query_scalar(
                    "SELECT COUNT(*) FROM memory_events WHERE is_deleted = 0",
                )
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
        };
        Ok(count.max(0) as usize)
    }

    async fn count_by_layer(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<LayerCounts, ApiError> {
        let rows = match (session_id, scope) {
            (Some(sid), Some(sc)) => {
                sqlx::query(
                    "SELECT memory_layer, COUNT(*) as c FROM memory_events
                     WHERE session_id = ?1 AND scope = ?2 AND is_deleted = 0
                     GROUP BY memory_layer",
                )
                .bind(sid)
                .bind(sc.as_str())
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (Some(sid), None) => {
                sqlx::query(
                    "SELECT memory_layer, COUNT(*) as c FROM memory_events
                     WHERE session_id = ?1 AND is_deleted = 0
                     GROUP BY memory_layer",
                )
                .bind(sid)
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, Some(sc)) => {
                sqlx::query(
                    "SELECT memory_layer, COUNT(*) as c FROM memory_events
                     WHERE scope = ?1 AND is_deleted = 0
                     GROUP BY memory_layer",
                )
                .bind(sc.as_str())
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, None) => {
                sqlx::query(
                    "SELECT memory_layer, COUNT(*) as c FROM memory_events
                     WHERE is_deleted = 0
                     GROUP BY memory_layer",
                )
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
        };

        let mut counts = LayerCounts::default();
        for row in &rows {
            let layer: String = row
                .try_get("memory_layer")
                .unwrap_or_else(|_| "SML".to_string());
            let c: i64 = row.try_get("c").unwrap_or(0);
            match parse_memory_layer(&layer) {
                MemoryLayer::LML => counts.lml = c.max(0) as usize,
                MemoryLayer::SML => counts.sml = c.max(0) as usize,
            }
        }
        Ok(counts)
    }

    async fn average_strength(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<f64, ApiError> {
        let avg: Option<f64> = match (session_id, scope) {
            (Some(sid), Some(sc)) => {
                sqlx::query_scalar(
                    "SELECT AVG(strength) FROM memory_events WHERE session_id = ?1 AND scope = ?2 AND is_deleted = 0",
                )
                .bind(sid)
                .bind(sc.as_str())
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (Some(sid), None) => {
                sqlx::query_scalar(
                    "SELECT AVG(strength) FROM memory_events WHERE session_id = ?1 AND is_deleted = 0",
                )
                .bind(sid)
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, Some(sc)) => {
                sqlx::query_scalar(
                    "SELECT AVG(strength) FROM memory_events WHERE scope = ?1 AND is_deleted = 0",
                )
                .bind(sc.as_str())
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, None) => {
                sqlx::query_scalar(
                    "SELECT AVG(strength) FROM memory_events WHERE is_deleted = 0",
                )
                .fetch_one(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
        };
        Ok(avg.unwrap_or(0.0))
    }

    async fn scope_stats(
        &self,
        session_id: &str,
        scope: MemoryScope,
    ) -> Result<ScopeStats, ApiError> {
        let total_events = self.count_events(Some(session_id), Some(scope)).await?;
        let layer_counts = self.count_by_layer(Some(session_id), Some(scope)).await?;
        let mean_strength = self.average_strength(Some(session_id), Some(scope)).await?;
        Ok(ScopeStats {
            total_events,
            layer_counts,
            mean_strength,
        })
    }

    // ===== Edges =====

    async fn insert_edge(&self, edge: &MemoryEdge) -> Result<(), ApiError> {
        sqlx::query(
            "INSERT OR REPLACE INTO memory_edges
                (id, session_id, from_event_id, to_event_id, edge_type, weight, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )
        .bind(&edge.id)
        .bind(&edge.session_id)
        .bind(&edge.from_event_id)
        .bind(&edge.to_event_id)
        .bind(edge.edge_type.as_str())
        .bind(edge.weight)
        .bind(edge.created_at.to_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn insert_edges(&self, edges: &[MemoryEdge]) -> Result<(), ApiError> {
        for edge in edges {
            self.insert_edge(edge).await?;
        }
        Ok(())
    }

    async fn get_edges_from(
        &self,
        event_id: &str,
        edge_type: Option<MemoryEdgeType>,
    ) -> Result<Vec<MemoryEdge>, ApiError> {
        let rows = if let Some(et) = edge_type {
            sqlx::query(
                "SELECT * FROM memory_edges WHERE from_event_id = ?1 AND edge_type = ?2",
            )
            .bind(event_id)
            .bind(et.as_str())
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT * FROM memory_edges WHERE from_event_id = ?1",
            )
            .bind(event_id)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };
        Ok(rows.iter().map(Self::row_to_edge).collect())
    }

    async fn get_edges_to(
        &self,
        event_id: &str,
        edge_type: Option<MemoryEdgeType>,
    ) -> Result<Vec<MemoryEdge>, ApiError> {
        let rows = if let Some(et) = edge_type {
            sqlx::query(
                "SELECT * FROM memory_edges WHERE to_event_id = ?1 AND edge_type = ?2",
            )
            .bind(event_id)
            .bind(et.as_str())
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        } else {
            sqlx::query(
                "SELECT * FROM memory_edges WHERE to_event_id = ?1",
            )
            .bind(event_id)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?
        };
        Ok(rows.iter().map(Self::row_to_edge).collect())
    }

    // ===== Compaction =====

    async fn create_compaction_job(&self, job: &CompactionJob) -> Result<(), ApiError> {
        sqlx::query(
            "INSERT INTO memory_compaction_jobs
                (id, session_id, scope, status, scanned_events, merged_groups, replaced_events, created_events, created_at, finished_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        )
        .bind(&job.id)
        .bind(&job.session_id)
        .bind(job.scope.as_str())
        .bind(job.status.as_str())
        .bind(job.scanned_events as i64)
        .bind(job.merged_groups as i64)
        .bind(job.replaced_events as i64)
        .bind(job.created_events as i64)
        .bind(job.created_at.to_rfc3339())
        .bind(job.finished_at.map(|dt| dt.to_rfc3339()))
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn update_compaction_job(&self, job: &CompactionJob) -> Result<(), ApiError> {
        sqlx::query(
            "UPDATE memory_compaction_jobs
             SET status = ?2, scanned_events = ?3, merged_groups = ?4,
                 replaced_events = ?5, created_events = ?6, finished_at = ?7
             WHERE id = ?1",
        )
        .bind(&job.id)
        .bind(job.status.as_str())
        .bind(job.scanned_events as i64)
        .bind(job.merged_groups as i64)
        .bind(job.replaced_events as i64)
        .bind(job.created_events as i64)
        .bind(job.finished_at.map(|dt| dt.to_rfc3339()))
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }

    async fn add_compaction_members(&self, members: &[CompactionMember]) -> Result<(), ApiError> {
        for m in members {
            sqlx::query(
                "INSERT INTO memory_compaction_members (id, job_id, original_event_id, new_event_id)
                 VALUES (?1,?2,?3,?4)",
            )
            .bind(&m.id)
            .bind(&m.job_id)
            .bind(&m.original_event_id)
            .bind(&m.new_event_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        }
        Ok(())
    }

    async fn list_compaction_jobs(
        &self,
        session_id: &str,
        scope: Option<MemoryScope>,
        status: Option<CompactionStatus>,
    ) -> Result<Vec<CompactionJob>, ApiError> {
        let rows = match (scope, status) {
            (Some(sc), Some(st)) => {
                sqlx::query(
                    "SELECT * FROM memory_compaction_jobs WHERE session_id = ?1 AND scope = ?2 AND status = ?3 ORDER BY created_at DESC",
                )
                .bind(session_id)
                .bind(sc.as_str())
                .bind(st.as_str())
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (Some(sc), None) => {
                sqlx::query(
                    "SELECT * FROM memory_compaction_jobs WHERE session_id = ?1 AND scope = ?2 ORDER BY created_at DESC",
                )
                .bind(session_id)
                .bind(sc.as_str())
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, Some(st)) => {
                sqlx::query(
                    "SELECT * FROM memory_compaction_jobs WHERE session_id = ?1 AND status = ?2 ORDER BY created_at DESC",
                )
                .bind(session_id)
                .bind(st.as_str())
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
            (None, None) => {
                sqlx::query(
                    "SELECT * FROM memory_compaction_jobs WHERE session_id = ?1 ORDER BY created_at DESC",
                )
                .bind(session_id)
                .fetch_all(&self.pool)
                .await
                .map_err(ApiError::internal)?
            }
        };
        Ok(rows.iter().map(Self::row_to_compaction_job).collect())
    }
}
