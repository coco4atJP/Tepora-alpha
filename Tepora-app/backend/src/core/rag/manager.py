"""
Source Manager - Document Source Management with Metadata Filtering

Manages document sources for RAG with session-based filtering.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class DocumentSource:
    """Represents a document source."""

    source_id: str
    session_id: str
    name: str
    source_type: str  # "file", "url", "text"
    content: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


class SourceManager:
    """
    Manages document sources for RAG with session-based filtering.

    Implements metadata filtering strategy for session-scoped RAG
    as specified in the architecture design.

    Usage:
        manager = SourceManager()

        # Add a document for a session
        manager.add_document(
            doc=DocumentSource(
                source_id="doc-1",
                session_id="session-123",
                name="example.pdf",
                source_type="file",
                content="...",
            )
        )

        # Get sources for a session
        sources = manager.get_sources(session_id="session-123")
    """

    def __init__(self):
        """Initialize source manager."""
        # In-memory store for documents (Phase 3 skeleton)
        # Future: integrate with ChromaDB or similar vector store
        self._sources: dict[str, DocumentSource] = {}

    def add_document(self, doc: DocumentSource) -> str:
        """
        Add a document source.

        Args:
            doc: Document source to add

        Returns:
            Source ID
        """
        self._sources[doc.source_id] = doc
        logger.info(
            "Added document source: %s (session=%s, type=%s)",
            doc.name,
            doc.session_id,
            doc.source_type,
        )
        return doc.source_id

    def get_sources(self, session_id: str) -> list[DocumentSource]:
        """
        Get all sources for a session.

        Args:
            session_id: Session ID to filter by

        Returns:
            List of document sources for the session
        """
        return [source for source in self._sources.values() if source.session_id == session_id]

    def get_source(self, source_id: str) -> DocumentSource | None:
        """
        Get a specific source by ID.

        Args:
            source_id: Source ID

        Returns:
            Document source or None if not found
        """
        return self._sources.get(source_id)

    def remove_source(self, source_id: str) -> bool:
        """
        Remove a source.

        Args:
            source_id: Source ID to remove

        Returns:
            True if removed, False if not found
        """
        if source_id in self._sources:
            del self._sources[source_id]
            logger.info("Removed document source: %s", source_id)
            return True
        return False

    def clear_session(self, session_id: str) -> int:
        """
        Clear all sources for a session.

        Args:
            session_id: Session ID

        Returns:
            Number of sources removed
        """
        to_remove = [
            source_id
            for source_id, source in self._sources.items()
            if source.session_id == session_id
        ]
        for source_id in to_remove:
            del self._sources[source_id]

        if to_remove:
            logger.info(
                "Cleared %d sources for session: %s",
                len(to_remove),
                session_id,
            )

        return len(to_remove)

    def list_all_sources(self) -> list[DocumentSource]:
        """Get all sources across all sessions."""
        return list(self._sources.values())

    @property
    def source_count(self) -> int:
        """Total number of sources."""
        return len(self._sources)
