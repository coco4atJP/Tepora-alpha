import json
import logging
import sqlite3
from datetime import datetime

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from .config.loader import DB_PATH

logger = logging.getLogger(__name__)


class ChatHistoryManager:
    def __init__(self, db_path: str = str(DB_PATH)):
        self.db_path = db_path
        self._init_db()

    @staticmethod
    def _serialize_message(message: BaseMessage, session_id: str) -> tuple:
        additional_kwargs = (
            message.additional_kwargs.copy() if isinstance(message.additional_kwargs, dict) else {}
        )

        if isinstance(message, ToolMessage) and hasattr(message, "tool_call_id"):
            additional_kwargs["tool_call_id"] = message.tool_call_id

        try:
            kwargs_payload = json.dumps(additional_kwargs, ensure_ascii=False, default=str)
        except (TypeError, ValueError) as exc:
            logger.warning(
                "Failed to serialize additional_kwargs for session %s: %s",
                session_id,
                exc,
                exc_info=True,
            )
            kwargs_payload = "{}"
        return (
            session_id,
            message.type,
            message.content,
            kwargs_payload,
        )

    @staticmethod
    def _deserialize_message(msg_type: str, content: str, kwargs: dict) -> BaseMessage | None:
        if msg_type == "human":
            return HumanMessage(content=content, additional_kwargs=kwargs)
        if msg_type == "ai":
            return AIMessage(content=content, additional_kwargs=kwargs)
        if msg_type == "system":
            return SystemMessage(content=content, additional_kwargs=kwargs)
        if msg_type == "tool":
            return ToolMessage(
                content=content,
                tool_call_id=kwargs.get("tool_call_id", ""),
                additional_kwargs=kwargs,
            )
        return None

    def _ensure_session(
        self,
        session_id: str = "default",
        title: str = "Default Session",
        cursor: sqlite3.Cursor | None = None,
    ):
        """Ensure a session exists in the database."""
        if cursor is None:
            try:
                with sqlite3.connect(self.db_path) as conn:
                    cursor = conn.cursor()
                    cursor.execute(
                        "INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)",
                        (session_id, title),
                    )
                    conn.commit()
            except sqlite3.Error as e:
                logger.error("Failed to ensure session %s: %s", session_id, e, exc_info=True)
            return

        try:
            cursor.execute(
                "INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)",
                (session_id, title),
            )
        except sqlite3.Error as e:
            logger.error("Failed to ensure session %s: %s", session_id, e, exc_info=True)

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
                cursor.execute(
                    "CREATE INDEX IF NOT EXISTS idx_session_id ON chat_history(session_id)"
                )
                conn.commit()
            logger.info("Chat history database initialized at %s", self.db_path)
        except sqlite3.Error as e:
            logger.error("Failed to initialize chat history DB: %s", e, exc_info=True)
            raise

    def get_history(self, session_id: str = "default", limit: int = 100) -> list[BaseMessage]:
        """Retrieve recent chat history for a session."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                # Get last N messages ordered by ID (asc)
                cursor.execute(
                    """
                    SELECT * FROM (
                        SELECT * FROM chat_history
                        WHERE session_id = ?
                        ORDER BY id DESC
                        LIMIT ?
                    ) ORDER BY id ASC
                """,
                    (session_id, limit),
                )

                rows = cursor.fetchall()
                messages = []
                for row in rows:
                    msg_type = row["type"]
                    content = row["content"]
                    kwargs = {}
                    if row["additional_kwargs"]:
                        try:
                            kwargs = json.loads(row["additional_kwargs"])
                        except (TypeError, json.JSONDecodeError) as exc:
                            logger.warning(
                                "Failed to decode additional_kwargs for message %s: %s",
                                row["id"],
                                exc,
                                exc_info=True,
                            )
                            kwargs = {}

                    message = self._deserialize_message(msg_type, content, kwargs)
                    if message:
                        messages.append(message)

                return messages
        except sqlite3.Error as e:
            logger.error("Failed to get chat history: %s", e, exc_info=True)
            return []

    def get_message_count(self, session_id: str = "default") -> int:
        """Get the total count of messages for a session."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT COUNT(*) FROM chat_history WHERE session_id = ?", (session_id,)
                )
                result = cursor.fetchone()
                return result[0] if result else 0
        except sqlite3.Error as e:
            logger.error("Failed to get message count: %s", e, exc_info=True)
            return 0

    def add_message(self, message: BaseMessage, session_id: str = "default"):
        """Add a single message to the history."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                self._ensure_session(session_id, cursor=cursor)
                cursor.execute(
                    """
                    INSERT INTO chat_history (session_id, type, content, additional_kwargs)
                    VALUES (?, ?, ?, ?)
                """,
                    self._serialize_message(message, session_id),
                )
                conn.commit()
        except sqlite3.Error as e:
            logger.error("Failed to add message to history: %s", e, exc_info=True)

    def add_messages(self, messages: list[BaseMessage], session_id: str = "default"):
        """Add multiple messages."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                data = [self._serialize_message(msg, session_id) for msg in messages]

                self._ensure_session(session_id, cursor=cursor)
                cursor.executemany(
                    """
                    INSERT INTO chat_history (session_id, type, content, additional_kwargs)
                    VALUES (?, ?, ?, ?)
                """,
                    data,
                )
                conn.commit()
        except sqlite3.Error as e:
            logger.error("Failed to add messages to history: %s", e, exc_info=True)

    def clear_history(self, session_id: str = "default"):
        """Clear history for a session."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM chat_history WHERE session_id = ?", (session_id,))
                conn.commit()
            logger.info("Cleared chat history for session %s", session_id)
        except sqlite3.Error as e:
            logger.error("Failed to clear history: %s", e, exc_info=True)

    def trim_history(self, session_id: str = "default", keep_last_n: int = 50):
        """Keep only the last N messages."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                # Find the ID of the Nth most recent message
                cursor.execute(
                    """
                    SELECT id FROM chat_history
                    WHERE session_id = ?
                    ORDER BY id DESC
                    LIMIT 1 OFFSET ?
                """,
                    (session_id, keep_last_n - 1),
                )
                row = cursor.fetchone()

                if row:
                    cutoff_id = row[0]
                    cursor.execute(
                        """
                        DELETE FROM chat_history
                        WHERE session_id = ? AND id < ?
                    """,
                        (session_id, cutoff_id),
                    )
                    conn.commit()
                    deleted_count = cursor.rowcount
                    if deleted_count > 0:
                        logger.info(
                            "Trimmed %d old messages for session %s",
                            deleted_count,
                            session_id,
                        )
        except sqlite3.Error as e:
            logger.error("Failed to trim history: %s", e, exc_info=True)

    def overwrite_history(self, messages: list[BaseMessage], session_id: str = "default"):
        """Overwrite the entire history for a session with the provided messages."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                # Use a transaction
                cursor.execute("DELETE FROM chat_history WHERE session_id = ?", (session_id,))

                data = [self._serialize_message(msg, session_id) for msg in messages]

                self._ensure_session(session_id, cursor=cursor)
                cursor.executemany(
                    """
                    INSERT INTO chat_history (session_id, type, content, additional_kwargs)
                    VALUES (?, ?, ?, ?)
                """,
                    data,
                )
                conn.commit()
                logger.info(
                    "Overwrote history for session %s with %d messages",
                    session_id,
                    len(messages),
                )
        except sqlite3.Error as e:
            logger.error("Failed to overwrite history: %s", e, exc_info=True)

    # --- Session Management Methods ---

    def create_session(self, title: str | None = None) -> str:
        """Create a new session and return its ID."""
        import uuid

        session_id = str(uuid.uuid4())
        if title is None:
            title = f"Session {datetime.now().strftime('%Y-%m-%d %H:%M')}"

        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO sessions (id, title) VALUES (?, ?)
                """,
                    (session_id, title),
                )
                conn.commit()
            logger.info("Created new session: %s with title '%s'", session_id, title)
            return session_id
        except sqlite3.Error as e:
            logger.error("Failed to create session: %s", e, exc_info=True)
            raise

    def list_sessions(self) -> list[dict]:
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
                        "preview": (row["last_message"] or "")[:100] if row["last_message"] else "",
                    }
                    for row in rows
                ]
        except sqlite3.Error as e:
            logger.error("Failed to list sessions: %s", e, exc_info=True)
            return []

    def get_session(self, session_id: str) -> dict | None:
        """Get a single session's metadata."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?
                """,
                    (session_id,),
                )
                row = cursor.fetchone()
                if row:
                    return {
                        "id": row["id"],
                        "title": row["title"],
                        "created_at": row["created_at"],
                        "updated_at": row["updated_at"],
                    }
                return None
        except sqlite3.Error as e:
            logger.error("Failed to get session: %s", e, exc_info=True)
            return None

    def update_session_title(self, session_id: str, title: str) -> bool:
        """Update a session's title."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                """,
                    (title, session_id),
                )
                conn.commit()
                if cursor.rowcount > 0:
                    logger.info("Updated session %s title to '%s'", session_id, title)
                    return True
                return False
        except sqlite3.Error as e:
            logger.error("Failed to update session title: %s", e, exc_info=True)
            return False

    def delete_session(self, session_id: str) -> bool:
        """Delete a session and all its messages."""
        if session_id == "default":
            # Allow deleting default session, but log it
            logger.info("Deleting default session")

        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                # Delete messages first (FK constraint)
                cursor.execute("DELETE FROM chat_history WHERE session_id = ?", (session_id,))
                cursor.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
                conn.commit()
                if cursor.rowcount > 0:
                    logger.info("Deleted session %s", session_id)
                    return True
                return False
        except sqlite3.Error as e:
            logger.error("Failed to delete session: %s", e, exc_info=True)
            return False

    def touch_session(self, session_id: str) -> None:
        """Update session's updated_at timestamp."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
                """,
                    (session_id,),
                )
                conn.commit()
        except sqlite3.Error as e:
            logger.error("Failed to touch session: %s", e, exc_info=True)
