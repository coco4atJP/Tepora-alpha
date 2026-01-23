"""
Session History - Wrapper for Chat History Management

Provides a clean interface around the existing SQLite-based ChatHistoryManager.
Decouples V2 components from direct V1 dependencies.
"""

from __future__ import annotations

import logging

from langchain_core.messages import BaseMessage

# Wrap existing ChatHistoryManager
from src.core.chat_history_manager import ChatHistoryManager

logger = logging.getLogger(__name__)


class SessionHistory:
    """
    Session history interface wrapping SQLite logic.

    This class provides a clean API for managing chat history
    while delegating persistence to the existing ChatHistoryManager.

    Usage:
        history = SessionHistory("session-123")

        # Get recent messages
        messages = history.get_messages(limit=50)

        # Add a message
        history.add_message(HumanMessage(content="Hello"))
    """

    def __init__(self, session_id: str):
        """
        Initialize session history.

        Args:
            session_id: Unique session identifier
        """
        self.session_id = session_id
        self._delegate = ChatHistoryManager()

        # Ensure session exists
        self._delegate._ensure_session(session_id)

        logger.debug("SessionHistory initialized for session: %s", session_id)

    def get_messages(self, limit: int = 100) -> list[BaseMessage]:
        """
        Get recent messages from history.

        Args:
            limit: Maximum number of messages to retrieve

        Returns:
            List of messages, oldest first
        """
        return self._delegate.get_history(
            session_id=self.session_id,
            limit=limit,
        )

    def get_message_count(self) -> int:
        """
        Get total message count for this session.

        Returns:
            Number of messages in history
        """
        return self._delegate.get_message_count(session_id=self.session_id)

    def add_message(self, message: BaseMessage) -> None:
        """
        Add a single message to history.

        Args:
            message: Message to add
        """
        self._delegate.add_message(message, session_id=self.session_id)
        logger.debug(
            "Added %s message to session %s",
            type(message).__name__,
            self.session_id,
        )

    def add_messages(self, messages: list[BaseMessage]) -> None:
        """
        Add multiple messages to history.

        Args:
            messages: Messages to add
        """
        self._delegate.add_messages(messages, session_id=self.session_id)
        logger.debug(
            "Added %d messages to session %s",
            len(messages),
            self.session_id,
        )

    def clear(self) -> None:
        """Clear all messages for this session."""
        self._delegate.clear_history(session_id=self.session_id)
        logger.info("Cleared history for session: %s", self.session_id)

    def trim(self, keep_last_n: int = 50) -> None:
        """
        Keep only the last N messages.

        Args:
            keep_last_n: Number of messages to keep
        """
        self._delegate.trim_history(
            session_id=self.session_id,
            keep_last_n=keep_last_n,
        )
        logger.debug(
            "Trimmed history to %d messages for session %s",
            keep_last_n,
            self.session_id,
        )

    def overwrite(self, messages: list[BaseMessage]) -> None:
        """
        Overwrite entire history with new messages.

        Args:
            messages: New message history
        """
        self._delegate.overwrite_history(
            messages,
            session_id=self.session_id,
        )
        logger.debug(
            "Overwrote history with %d messages for session %s",
            len(messages),
            self.session_id,
        )

    @property
    def is_empty(self) -> bool:
        """Check if history is empty."""
        return self.get_message_count() == 0

    def __repr__(self) -> str:
        return f"SessionHistory(session_id={self.session_id!r})"
