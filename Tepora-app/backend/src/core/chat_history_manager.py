import sqlite3
import json
import logging
from typing import List, Optional, Dict
from pathlib import Path
from datetime import datetime

from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage
from langchain_core.messages import messages_to_dict, messages_from_dict

from .config.loader import DB_PATH

logger = logging.getLogger(__name__)

class ChatHistoryManager:
    def __init__(self, db_path: str = str(DB_PATH)):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        """Initialize the SQLite database schema."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                # Sessions table for session metadata
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS sessions (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                # Insert default session if not exists
                cursor.execute("""
                    INSERT OR IGNORE INTO sessions (id, title) VALUES ('default', 'Default Session')
                """)
                # Chat history table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS chat_history (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id TEXT NOT NULL DEFAULT 'default',
                        type TEXT NOT NULL,
                        content TEXT,
                        additional_kwargs TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                    )
                """)
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_session_id ON chat_history(session_id)")
                conn.commit()
            logger.info(f"Chat history database initialized at {self.db_path}")
        except Exception as e:
            logger.error(f"Failed to initialize chat history DB: {e}", exc_info=True)
            raise

    def get_history(self, session_id: str = "default", limit: int = 100) -> List[BaseMessage]:
        """Retrieve recent chat history for a session."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                # Get last N messages ordered by ID (asc)
                cursor.execute("""
                    SELECT * FROM (
                        SELECT * FROM chat_history 
                        WHERE session_id = ? 
                        ORDER BY id DESC 
                        LIMIT ?
                    ) ORDER BY id ASC
                """, (session_id, limit))
                
                rows = cursor.fetchall()
                messages = []
                for row in rows:
                    msg_type = row['type']
                    content = row['content']
                    kwargs = json.loads(row['additional_kwargs']) if row['additional_kwargs'] else {}
                    
                    if msg_type == "human":
                        messages.append(HumanMessage(content=content, additional_kwargs=kwargs))
                    elif msg_type == "ai":
                        messages.append(AIMessage(content=content, additional_kwargs=kwargs))
                    elif msg_type == "system":
                        messages.append(SystemMessage(content=content, additional_kwargs=kwargs))
                    elif msg_type == "tool":
                        messages.append(ToolMessage(content=content, tool_call_id=kwargs.get("tool_call_id", ""), additional_kwargs=kwargs))
                    # Add other types as needed
                
                return messages
        except Exception as e:
            logger.error(f"Failed to get chat history: {e}", exc_info=True)
            return []

    def get_message_count(self, session_id: str = "default") -> int:
        """Get the total count of messages for a session."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM chat_history WHERE session_id = ?", 
                    (session_id,)
                )
                result = cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            logger.error(f"Failed to get message count: {e}", exc_info=True)
            return 0

    def add_message(self, message: BaseMessage, session_id: str = "default"):
        """Add a single message to the history."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                msg_type = message.type
                content = message.content
                additional_kwargs = json.dumps(message.additional_kwargs)
                
                cursor.execute("""
                    INSERT INTO chat_history (session_id, type, content, additional_kwargs)
                    VALUES (?, ?, ?, ?)
                """, (session_id, msg_type, content, additional_kwargs))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to add message to history: {e}", exc_info=True)

    def add_messages(self, messages: List[BaseMessage], session_id: str = "default"):
        """Add multiple messages."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                data = []
                for msg in messages:
                    data.append((
                        session_id, 
                        msg.type, 
                        msg.content, 
                        json.dumps(msg.additional_kwargs)
                    ))
                
                cursor.executemany("""
                    INSERT INTO chat_history (session_id, type, content, additional_kwargs)
                    VALUES (?, ?, ?, ?)
                """, data)
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to add messages to history: {e}", exc_info=True)

    def clear_history(self, session_id: str = "default"):
        """Clear history for a session."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM chat_history WHERE session_id = ?", (session_id,))
                conn.commit()
            logger.info(f"Cleared chat history for session {session_id}")
        except Exception as e:
            logger.error(f"Failed to clear history: {e}", exc_info=True)

    def trim_history(self, session_id: str = "default", keep_last_n: int = 50):
        """Keep only the last N messages."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                # Find the ID of the Nth most recent message
                cursor.execute("""
                    SELECT id FROM chat_history 
                    WHERE session_id = ? 
                    ORDER BY id DESC 
                    LIMIT 1 OFFSET ?
                """, (session_id, keep_last_n - 1))
                row = cursor.fetchone()
                
                if row:
                    cutoff_id = row[0]
                    cursor.execute("""
                        DELETE FROM chat_history 
                        WHERE session_id = ? AND id < ?
                    """, (session_id, cutoff_id))
                    conn.commit()
                    deleted_count = cursor.rowcount
                    if deleted_count > 0:
                        logger.info(f"Trimmed {deleted_count} old messages for session {session_id}")
        except Exception as e:
            logger.error(f"Failed to trim history: {e}", exc_info=True)

    def overwrite_history(self, messages: List[BaseMessage], session_id: str = "default"):
        """Overwrite the entire history for a session with the provided messages."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                # Use a transaction
                cursor.execute("DELETE FROM chat_history WHERE session_id = ?", (session_id,))
                
                data = []
                for msg in messages:
                    data.append((
                        session_id, 
                        msg.type, 
                        msg.content, 
                        json.dumps(msg.additional_kwargs)
                    ))
                
                cursor.executemany("""
                    INSERT INTO chat_history (session_id, type, content, additional_kwargs)
                    VALUES (?, ?, ?, ?)
                """, data)
                conn.commit()
                logger.info(f"Overwrote history for session {session_id} with {len(messages)} messages")
        except Exception as e:
            logger.error(f"Failed to overwrite history: {e}", exc_info=True)

    # --- Session Management Methods ---

    def create_session(self, title: Optional[str] = None) -> str:
        """Create a new session and return its ID."""
        import uuid
        session_id = str(uuid.uuid4())
        if title is None:
            title = f"Session {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT INTO sessions (id, title) VALUES (?, ?)
                """, (session_id, title))
                conn.commit()
            logger.info(f"Created new session: {session_id} with title '{title}'")
            return session_id
        except Exception as e:
            logger.error(f"Failed to create session: {e}", exc_info=True)
            raise

    def list_sessions(self) -> List[Dict]:
        """List all sessions with metadata."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT s.id, s.title, s.created_at, s.updated_at,
                           (SELECT COUNT(*) FROM chat_history WHERE session_id = s.id) as message_count,
                           (SELECT content FROM chat_history WHERE session_id = s.id ORDER BY id DESC LIMIT 1) as last_message
                    FROM sessions s
                    ORDER BY s.updated_at DESC
                """)
                rows = cursor.fetchall()
                return [
                    {
                        "id": row["id"],
                        "title": row["title"],
                        "created_at": row["created_at"],
                        "updated_at": row["updated_at"],
                        "message_count": row["message_count"],
                        "preview": (row["last_message"] or "")[:100] if row["last_message"] else ""
                    }
                    for row in rows
                ]
        except Exception as e:
            logger.error(f"Failed to list sessions: {e}", exc_info=True)
            return []

    def get_session(self, session_id: str) -> Optional[Dict]:
        """Get a single session's metadata."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?
                """, (session_id,))
                row = cursor.fetchone()
                if row:
                    return {
                        "id": row["id"],
                        "title": row["title"],
                        "created_at": row["created_at"],
                        "updated_at": row["updated_at"]
                    }
                return None
        except Exception as e:
            logger.error(f"Failed to get session: {e}", exc_info=True)
            return None

    def update_session_title(self, session_id: str, title: str) -> bool:
        """Update a session's title."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                """, (title, session_id))
                conn.commit()
                if cursor.rowcount > 0:
                    logger.info(f"Updated session {session_id} title to '{title}'")
                    return True
                return False
        except Exception as e:
            logger.error(f"Failed to update session title: {e}", exc_info=True)
            return False

    def delete_session(self, session_id: str) -> bool:
        """Delete a session and all its messages."""
        if session_id == "default":
            logger.warning("Cannot delete default session")
            return False
        
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                # Delete messages first (FK constraint)
                cursor.execute("DELETE FROM chat_history WHERE session_id = ?", (session_id,))
                cursor.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
                conn.commit()
                if cursor.rowcount > 0:
                    logger.info(f"Deleted session {session_id}")
                    return True
                return False
        except Exception as e:
            logger.error(f"Failed to delete session: {e}", exc_info=True)
            return False

    def touch_session(self, session_id: str) -> None:
        """Update session's updated_at timestamp."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
                """, (session_id,))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to touch session: {e}", exc_info=True)

