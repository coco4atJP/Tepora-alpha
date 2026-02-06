use std::path::PathBuf;
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::errors::ApiError;

const SCHEMA_VERSION: i64 = 2;
const DEFAULT_SESSION_ID: &str = "default";
const DEFAULT_SESSION_TITLE: &str = "Default Session";
const MAX_HISTORY_LIMIT: i64 = 1000;
const MAX_TITLE_LEN: usize = 160;

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionDetail {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct HistoryMessage {
    pub message_type: String,
    pub content: String,
    pub additional_kwargs: Value,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct HistoryStore {
    db_path: PathBuf,
    pool: SqlitePool,
}

impl HistoryStore {
    pub async fn new(db_path: PathBuf) -> Result<Self, ApiError> {
        let connect_options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .min_connections(1)
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(connect_options)
            .await
            .map_err(ApiError::internal)?;

        let store = Self { db_path, pool };
        store.init_db().await?;
        Ok(store)
    }

    pub fn db_path(&self) -> &PathBuf {
        &self.db_path
    }

    async fn init_db(&self) -> Result<(), ApiError> {
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        if version != SCHEMA_VERSION {
            self.rebuild_schema().await?;
        }

        Ok(())
    }

    async fn rebuild_schema(&self) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await.map_err(ApiError::internal)?;

        sqlx::query("DROP TABLE IF EXISTS messages")
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        sqlx::query("DROP TABLE IF EXISTS chat_history")
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        sqlx::query("DROP TABLE IF EXISTS sessions")
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;

        sqlx::query(
            "\
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )",
        )
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

        sqlx::query(
            "\
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('human', 'ai', 'system', 'tool')),
                content TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )",
        )
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

        sqlx::query("CREATE INDEX idx_sessions_updated_at ON sessions(updated_at DESC)")
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        sqlx::query("CREATE INDEX idx_messages_session_id_id ON messages(session_id, id)")
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;

        sqlx::query("INSERT INTO sessions (id, title) VALUES (?1, ?2)")
            .bind(DEFAULT_SESSION_ID)
            .bind(DEFAULT_SESSION_TITLE)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;

        let pragma = format!("PRAGMA user_version = {}", SCHEMA_VERSION);
        sqlx::query(&pragma)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;

        tx.commit().await.map_err(ApiError::internal)?;
        Ok(())
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>, ApiError> {
        let rows = sqlx::query(
            "\
            SELECT s.id, s.title, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count,
                   (SELECT content FROM messages WHERE session_id = s.id ORDER BY id DESC LIMIT 1) as last_message
            FROM sessions s
            ORDER BY s.updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        rows.into_iter()
            .map(session_info_from_row)
            .collect::<Result<Vec<_>, _>>()
            .map_err(ApiError::internal)
    }

    pub async fn create_session(&self, title: Option<String>) -> Result<String, ApiError> {
        let session_id = Uuid::new_v4().to_string();
        let title = normalize_title(title);

        sqlx::query("INSERT INTO sessions (id, title) VALUES (?1, ?2)")
            .bind(&session_id)
            .bind(title)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        Ok(session_id)
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Option<SessionDetail>, ApiError> {
        let row =
            sqlx::query("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?1")
                .bind(session_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(ApiError::internal)?;

        row.map(session_detail_from_row)
            .transpose()
            .map_err(ApiError::internal)
    }

    pub async fn update_session_title(
        &self,
        session_id: &str,
        title: &str,
    ) -> Result<bool, ApiError> {
        let title = normalize_title(Some(title.to_string()));

        let result = sqlx::query(
            "UPDATE sessions SET title = ?1, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
        )
        .bind(title)
        .bind(session_id)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<bool, ApiError> {
        let result = sqlx::query("DELETE FROM sessions WHERE id = ?1")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn get_history(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<HistoryMessage>, ApiError> {
        let limit = sanitize_limit(limit);

        let rows = sqlx::query(
            "\
            SELECT role, content, metadata, created_at
            FROM (
                SELECT id, role, content, metadata, created_at
                FROM messages
                WHERE session_id = ?1
                ORDER BY id DESC
                LIMIT ?2
            )
            ORDER BY id ASC",
        )
        .bind(session_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        rows.into_iter()
            .map(history_message_from_row)
            .collect::<Result<Vec<_>, _>>()
            .map_err(ApiError::internal)
    }

    pub async fn get_message_count(&self, session_id: &str) -> Result<i64, ApiError> {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM messages WHERE session_id = ?1")
            .bind(session_id)
            .fetch_one(&self.pool)
            .await
            .map_err(ApiError::internal)
    }

    pub async fn add_message(
        &self,
        session_id: &str,
        message_type: &str,
        content: &str,
        additional_kwargs: &Value,
    ) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await.map_err(ApiError::internal)?;
        ensure_session(&mut tx, session_id).await?;

        let role = normalize_role(message_type);
        let payload = serde_json::to_string(additional_kwargs).map_err(ApiError::internal)?;

        sqlx::query(
            "\
            INSERT INTO messages (session_id, role, content, metadata)
            VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(session_id)
        .bind(role)
        .bind(content)
        .bind(payload)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

        touch_session_tx(&mut tx, session_id).await?;

        tx.commit().await.map_err(ApiError::internal)?;
        Ok(())
    }

    pub async fn touch_session(&self, session_id: &str) -> Result<(), ApiError> {
        sqlx::query(
            "UPDATE sessions SET updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        )
        .bind(session_id)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(())
    }
}

fn session_info_from_row(row: sqlx::sqlite::SqliteRow) -> Result<SessionInfo, sqlx::Error> {
    let last_message: Option<String> = row.try_get("last_message")?;
    let preview = last_message.unwrap_or_default().chars().take(100).collect();

    Ok(SessionInfo {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        message_count: row.try_get("message_count")?,
        preview,
    })
}

fn session_detail_from_row(row: sqlx::sqlite::SqliteRow) -> Result<SessionDetail, sqlx::Error> {
    Ok(SessionDetail {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn history_message_from_row(row: sqlx::sqlite::SqliteRow) -> Result<HistoryMessage, sqlx::Error> {
    let raw_metadata: String = row.try_get("metadata")?;
    let additional_kwargs =
        serde_json::from_str(&raw_metadata).unwrap_or(Value::Object(serde_json::Map::new()));

    Ok(HistoryMessage {
        message_type: row.try_get("role")?,
        content: row.try_get("content")?,
        additional_kwargs,
        created_at: row.try_get("created_at")?,
    })
}

async fn ensure_session(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
) -> Result<(), ApiError> {
    sqlx::query("INSERT OR IGNORE INTO sessions (id, title) VALUES (?1, ?2)")
        .bind(session_id)
        .bind(DEFAULT_SESSION_TITLE)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

async fn touch_session_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE sessions SET updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
    )
    .bind(session_id)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}

fn sanitize_limit(limit: i64) -> i64 {
    if limit <= 0 {
        return 1;
    }
    limit.min(MAX_HISTORY_LIMIT)
}

fn normalize_role(role: &str) -> &'static str {
    match role {
        "human" => "human",
        "ai" => "ai",
        "system" => "system",
        "tool" => "tool",
        _ => "human",
    }
}

fn normalize_title(title: Option<String>) -> String {
    let fallback = || format!("Session {}", Utc::now().format("%Y-%m-%d %H:%M"));

    let Some(raw) = title else {
        return fallback();
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback();
    }

    trimmed.chars().take(MAX_TITLE_LEN).collect()
}
