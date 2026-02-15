use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};

use crate::core::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: Option<Value>,
    // Computed fields
    #[serde(default)]
    pub message_count: i64,
    #[serde(default)]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMessage {
    pub id: i64,
    pub session_id: String,
    pub message_type: String, // Was role
    pub content: String,
    pub created_at: String,
    pub additional_kwargs: Option<Value>,
}

#[derive(Clone)]
pub struct HistoryStore {
    pool: SqlitePool,
}

impl HistoryStore {
    pub async fn new(db_path: PathBuf) -> Result<Self, ApiError> {
        let conn_str = format!("sqlite://{}?mode=rwc", db_path.to_string_lossy());
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&conn_str)
            .await
            .map_err(|e| ApiError::internal(format!("Failed to connect to history db: {}", e)))?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                metadata JSON
            )",
        )
        .execute(&pool)
        .await
        .map_err(|e| ApiError::internal(format!("Failed to init sessions table: {}", e)))?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                additional_kwargs JSON,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )",
        )
        .execute(&pool)
        .await
        .map_err(|e| ApiError::internal(format!("Failed to init messages table: {}", e)))?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)")
            .execute(&pool)
            .await
            .map_err(|e| ApiError::internal(format!("Failed to create index: {}", e)))?;

        Ok(Self { pool })
    }

    pub async fn create_session(&self, title: Option<String>) -> Result<String, ApiError> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO sessions (id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&session_id)
        .bind(title)
        .bind(&now)
        .bind(&now)
        .bind(Value::Null)
        .execute(&self.pool)
        .await
        .map_err(|e| ApiError::internal(format!("Failed to create session: {}", e)))?;

        Ok(session_id)
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Option<SessionInfo>, ApiError> {
        let row = sqlx::query("SELECT * FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        if let Some(row) = row {
            // Fetch message count and preview potentially?
            // For now just basic info
            let count: i64 = sqlx::query("SELECT COUNT(*) FROM messages WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(&self.pool)
                .await
                .map(|r| r.get(0))
                .unwrap_or(0);

            Ok(Some(SessionInfo {
                id: row.try_get::<String, _>("id").unwrap_or_default(),
                title: row.try_get::<Option<String>, _>("title").unwrap_or(None),
                created_at: row.try_get::<String, _>("created_at").unwrap_or_default(),
                updated_at: row.try_get::<String, _>("updated_at").unwrap_or_default(),
                metadata: row.try_get::<Option<Value>, _>("metadata").unwrap_or(None),
                message_count: count,
                preview: None,
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>, ApiError> {
        // Assume default limit for now to match old signature (no args)
        let rows = sqlx::query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 100")
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        let mut sessions = Vec::new();
        for row in rows {
            let id: String = row.try_get::<String, _>("id").unwrap_or_default();
            let count: i64 = sqlx::query("SELECT COUNT(*) FROM messages WHERE session_id = ?")
                .bind(&id)
                .fetch_one(&self.pool)
                .await
                .map(|r| r.get(0))
                .unwrap_or(0);

            sessions.push(SessionInfo {
                id,
                title: row.try_get::<Option<String>, _>("title").unwrap_or(None),
                created_at: row.try_get::<String, _>("created_at").unwrap_or_default(),
                updated_at: row.try_get::<String, _>("updated_at").unwrap_or_default(),
                metadata: row.try_get::<Option<Value>, _>("metadata").unwrap_or(None),
                message_count: count,
                preview: None,
            });
        }
        Ok(sessions)
    }

    pub async fn update_session_title(
        &self,
        session_id: &str,
        title: &str,
    ) -> Result<(), ApiError> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(now)
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        Ok(())
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<(), ApiError> {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        Ok(())
    }

    pub async fn add_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        additional_kwargs: Option<Value>,
    ) -> Result<i64, ApiError> {
        let now = chrono::Utc::now().to_rfc3339();

        // Touch session
        sqlx::query("UPDATE sessions SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        let result = sqlx::query(
            "INSERT INTO messages (session_id, role, content, created_at, additional_kwargs) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(role)
        .bind(content)
        .bind(now)
        .bind(additional_kwargs)
        .execute(&self.pool)
        .await
        .map_err(ApiError::internal)?;

        Ok(result.last_insert_rowid())
    }

    pub async fn get_history(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<HistoryMessage>, ApiError> {
        let rows = sqlx::query("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC") // Limit? Old logic didn't usually limit history for context context building needs all, but UI might need limit.
            // If explicit limit needed:
            // "SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC"
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .map_err(ApiError::internal)?;

        let mut messages = Vec::new();
        for row in rows {
            messages.push(HistoryMessage {
                id: row.try_get::<i64, _>("id").unwrap_or_default(),
                session_id: row.try_get::<String, _>("session_id").unwrap_or_default(),
                message_type: row.try_get::<String, _>("role").unwrap_or_default(),
                content: row.try_get::<String, _>("content").unwrap_or_default(),
                created_at: row.try_get::<String, _>("created_at").unwrap_or_default(),
                additional_kwargs: row
                    .try_get::<Option<Value>, _>("additional_kwargs")
                    .unwrap_or(None),
            });
        }

        // Apply limit in memory if simple
        if limit > 0 && messages.len() > limit as usize {
            let start = messages.len() - limit as usize;
            return Ok(messages[start..].to_vec());
        }

        Ok(messages)
    }

    pub async fn get_message_count(&self, session_id: &str) -> Result<i64, ApiError> {
        let count: i64 = sqlx::query("SELECT COUNT(*) FROM messages WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(&self.pool)
            .await
            .map(|r| r.get(0))
            .unwrap_or(0);
        Ok(count)
    }

    pub async fn touch_session(&self, session_id: &str) -> Result<(), ApiError> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE sessions SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(ApiError::internal)?;
        Ok(())
    }
}
