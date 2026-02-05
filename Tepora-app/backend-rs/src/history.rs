use std::path::PathBuf;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Row};
use serde_json::Value;
use uuid::Uuid;

use crate::errors::ApiError;

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub preview: String,
}

#[derive(Debug, Clone)]
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
}

impl HistoryStore {
    pub fn new(db_path: PathBuf) -> Result<Self, ApiError> {
        let store = Self { db_path };
        store.init_db()?;
        Ok(store)
    }

    pub fn db_path(&self) -> &PathBuf {
        &self.db_path
    }

    fn init_db(&self) -> Result<(), ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        conn.execute_batch(
            "\
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL DEFAULT 'default',
                type TEXT NOT NULL,
                content TEXT,
                additional_kwargs TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_id ON chat_history(session_id);
            INSERT OR IGNORE INTO sessions (id, title) VALUES ('default', 'Default Session');
        ",
        )
        .map_err(ApiError::internal)?;

        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionInfo>, ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        let mut stmt = conn
            .prepare(
                "\
                SELECT s.id, s.title, s.created_at, s.updated_at,
                       (SELECT COUNT(*) FROM chat_history WHERE session_id = s.id) as message_count,
                       (SELECT content FROM chat_history WHERE session_id = s.id ORDER BY id DESC LIMIT 1) as last_message
                FROM sessions s
                ORDER BY s.updated_at DESC
                ",
            )
            .map_err(ApiError::internal)?;

        let rows = stmt
            .query_map([], |row| session_info_from_row(row))
            .map_err(ApiError::internal)?;

        let mut sessions = Vec::new();
        for row in rows {
            if let Ok(session) = row {
                sessions.push(session);
            }
        }
        Ok(sessions)
    }

    pub fn create_session(&self, title: Option<String>) -> Result<String, ApiError> {
        let session_id = Uuid::new_v4().to_string();
        let title =
            title.unwrap_or_else(|| format!("Session {}", Utc::now().format("%Y-%m-%d %H:%M")));

        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        conn.execute(
            "INSERT INTO sessions (id, title) VALUES (?1, ?2)",
            params![session_id, title],
        )
        .map_err(ApiError::internal)?;

        Ok(session_id)
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionDetail>, ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        let mut stmt = conn
            .prepare("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?1")
            .map_err(ApiError::internal)?;

        let mut rows = stmt
            .query(params![session_id])
            .map_err(ApiError::internal)?;
        if let Some(row) = rows.next().map_err(ApiError::internal)? {
            return Ok(Some(SessionDetail {
                id: row.get(0).unwrap_or_default(),
                title: row.get(1).unwrap_or_default(),
                created_at: row.get(2).unwrap_or_default(),
                updated_at: row.get(3).unwrap_or_default(),
            }));
        }
        Ok(None)
    }

    pub fn update_session_title(&self, session_id: &str, title: &str) -> Result<bool, ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        let rows = conn
            .execute(
                "UPDATE sessions SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![title, session_id],
            )
            .map_err(ApiError::internal)?;
        Ok(rows > 0)
    }

    pub fn delete_session(&self, session_id: &str) -> Result<bool, ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        let rows = conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(ApiError::internal)?;
        conn.execute(
            "DELETE FROM chat_history WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(ApiError::internal)?;
        Ok(rows > 0)
    }

    pub fn get_history(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<HistoryMessage>, ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        let mut stmt = conn
            .prepare(
                "\
                SELECT * FROM (
                    SELECT type, content, additional_kwargs, created_at
                    FROM chat_history
                    WHERE session_id = ?1
                    ORDER BY id DESC
                    LIMIT ?2
                ) ORDER BY rowid ASC",
            )
            .map_err(ApiError::internal)?;

        let rows = stmt
            .query_map(params![session_id, limit], |row| {
                history_message_from_row(row)
            })
            .map_err(ApiError::internal)?;

        let mut messages = Vec::new();
        for row in rows {
            if let Ok(msg) = row {
                messages.push(msg);
            }
        }
        Ok(messages)
    }

    pub fn get_message_count(&self, session_id: &str) -> Result<i64, ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_history WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(ApiError::internal)?;
        Ok(count)
    }

    pub fn add_message(
        &self,
        session_id: &str,
        message_type: &str,
        content: &str,
        additional_kwargs: &Value,
    ) -> Result<(), ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        ensure_session(&conn, session_id)?;
        let kwargs_payload =
            serde_json::to_string(additional_kwargs).unwrap_or_else(|_| "{}".to_string());
        conn.execute(
            "INSERT INTO chat_history (session_id, type, content, additional_kwargs) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, message_type, content, kwargs_payload],
        )
        .map_err(ApiError::internal)?;
        Ok(())
    }

    pub fn touch_session(&self, session_id: &str) -> Result<(), ApiError> {
        let conn = Connection::open(&self.db_path).map_err(ApiError::internal)?;
        conn.execute(
            "UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![session_id],
        )
        .map_err(ApiError::internal)?;
        Ok(())
    }
}

fn session_info_from_row(row: &Row) -> rusqlite::Result<SessionInfo> {
    let last_message: Option<String> = row.get("last_message")?;
    let preview = last_message.unwrap_or_default().chars().take(100).collect();

    Ok(SessionInfo {
        id: row.get("id")?,
        title: row.get("title")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        message_count: row.get("message_count")?,
        preview,
    })
}

fn history_message_from_row(row: &Row) -> rusqlite::Result<HistoryMessage> {
    let raw_kwargs: Option<String> = row.get("additional_kwargs")?;
    let additional_kwargs = raw_kwargs
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Object(serde_json::Map::new()));

    Ok(HistoryMessage {
        message_type: row.get("type")?,
        content: row.get("content")?,
        additional_kwargs,
        created_at: row.get::<_, String>("created_at")?,
    })
}

fn ensure_session(conn: &Connection, session_id: &str) -> Result<(), ApiError> {
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, title) VALUES (?1, ?2)",
        params![session_id, "Default Session"],
    )
    .map_err(ApiError::internal)?;
    Ok(())
}

fn _to_iso(timestamp: DateTime<Utc>) -> String {
    timestamp.to_rfc3339()
}
