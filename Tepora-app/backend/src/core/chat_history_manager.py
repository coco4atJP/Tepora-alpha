import sqlite3
import json
import logging
from typing import List, Optional
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
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS chat_history (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id TEXT NOT NULL DEFAULT 'default',
                        type TEXT NOT NULL,
                        content TEXT,
                        additional_kwargs TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
