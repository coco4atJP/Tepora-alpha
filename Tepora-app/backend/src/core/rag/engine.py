"""
RAG Engine - Retrieval-Augmented Generation Logic

Collects and processes chunks from web content and attachments.
Tool execution is dependency-injected to maintain module separation.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_text_splitters import RecursiveCharacterTextSplitter

logger = logging.getLogger(__name__)


# Type alias for tool executor function
ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[str | Any]]


class RAGEngine:
    """
    RAG retrieval engine for collecting chunks from various sources.

    Handles:
    - Web content fetching (via injected tool executor)
    - Attachment processing
    - Text chunking

    Usage:
        engine = RAGEngine()

        chunk_texts, chunk_sources = await engine.collect_chunks(
            top_result_url="https://example.com",
            attachments=[{"name": "doc.txt", "content": "..."}],
            tool_executor=tool_manager.aexecute_tool,
        )
    """

    def __init__(
        self,
        chunk_size: int = 500,
        chunk_overlap: int = 50,
    ):
        """
        Initialize RAG engine.

        Args:
            chunk_size: Size of text chunks
            chunk_overlap: Overlap between chunks
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def _create_text_splitter(self) -> RecursiveCharacterTextSplitter:
        """Create text splitter with configured parameters."""
        return RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )

    @staticmethod
    def _parse_tool_error(payload: str) -> str | None:
        """Parse error from tool response payload."""
        payload_stripped = payload.lstrip()
        if not payload_stripped.startswith("{"):
            return None
        try:
            data = json.loads(payload_stripped)
        except json.JSONDecodeError:
            return None
        if isinstance(data, dict) and data.get("error"):
            return data.get("message") or data.get("error_code") or "Tool error"
        return None

    async def collect_chunks(
        self,
        *,
        top_result_url: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
        tool_executor: ToolExecutor | None = None,
        skip_web_fetch: bool = False,
    ) -> tuple[list[str], list[str]]:
        """
        Collect text chunks from web content and attachments.

        Args:
            top_result_url: URL to fetch content from
            attachments: List of attachment dicts with 'content' key
            tool_executor: Async function to execute tools (for web fetch)
            skip_web_fetch: Skip web fetching even if URL provided

        Returns:
            Tuple of (chunk_texts, chunk_sources)
        """
        text_splitter = self._create_text_splitter()
        chunk_texts: list[str] = []
        chunk_sources: list[str] = []

        # Fetch web content if URL provided
        if top_result_url and tool_executor and not skip_web_fetch:
            web_chunks, web_sources = await self._fetch_web_content(
                url=top_result_url,
                tool_executor=tool_executor,
                text_splitter=text_splitter,
            )
            chunk_texts.extend(web_chunks)
            chunk_sources.extend(web_sources)
        elif skip_web_fetch:
            logger.info("Web search disabled - using attachments only for RAG")

        # Process attachments
        if attachments:
            att_chunks, att_sources = self._process_attachments(
                attachments=attachments,
                text_splitter=text_splitter,
            )
            chunk_texts.extend(att_chunks)
            chunk_sources.extend(att_sources)

        logger.info(
            "RAG collected %d chunks from %d sources",
            len(chunk_texts),
            len(set(chunk_sources)),
        )

        return chunk_texts, chunk_sources

    async def _fetch_web_content(
        self,
        url: str,
        tool_executor: ToolExecutor,
        text_splitter: RecursiveCharacterTextSplitter,
    ) -> tuple[list[str], list[str]]:
        """Fetch and chunk web content."""
        chunk_texts: list[str] = []
        chunk_sources: list[str] = []

        logger.info("Fetching web content from: %s", url)

        try:
            content = await tool_executor("native_web_fetch", {"url": url})
        except Exception as exc:
            logger.warning("Web fetch failed for URL '%s': %s", url, exc)
            return chunk_texts, chunk_sources

        if not isinstance(content, str) or not content:
            logger.warning("Empty content from URL: %s", url)
            return chunk_texts, chunk_sources

        if content.startswith("Error:"):
            logger.warning("Web fetch error for URL '%s': %s", url, content)
            return chunk_texts, chunk_sources

        # Check for tool error in JSON response
        tool_error = self._parse_tool_error(content)
        if tool_error:
            logger.warning("Web fetch failed for URL '%s': %s", url, tool_error)
            return chunk_texts, chunk_sources

        # Split content into chunks
        logger.info("Fetched %d chars. Chunking...", len(content))
        chunks = text_splitter.split_text(content)
        logger.info("Split into %d chunks from web page.", len(chunks))

        for chunk in chunks:
            chunk_texts.append(chunk)
            chunk_sources.append(f"web:{url}")

        return chunk_texts, chunk_sources

    def _process_attachments(
        self,
        attachments: list[dict[str, Any]],
        text_splitter: RecursiveCharacterTextSplitter,
    ) -> tuple[list[str], list[str]]:
        """Process attachments into chunks."""
        chunk_texts: list[str] = []
        chunk_sources: list[str] = []

        for attachment in attachments:
            content = attachment.get("content", "")
            if not isinstance(content, str):
                content = str(content)
            if not content:
                continue

            source_label = attachment.get("path") or attachment.get("name") or "attachment"

            file_chunks = text_splitter.split_text(content)
            logger.info(
                "Attachment '%s' yielded %d chunk(s).",
                source_label,
                len(file_chunks),
            )

            for chunk in file_chunks:
                chunk_texts.append(chunk)
                chunk_sources.append(f"file:{source_label}")

        return chunk_texts, chunk_sources
