from __future__ import annotations

import asyncio
import logging
from typing import Any

from duckduckgo_search import DDGS  # type: ignore[import-untyped]

from ..base import SearchEngine, SearchResult

logger = logging.getLogger(__name__)


class DuckDuckGoSearchEngine(SearchEngine):
    """DuckDuckGo Search implementation using duckduckgo_search library."""

    @property
    def name(self) -> str:
        return "duckduckgo"

    def search(self, query: str, **kwargs: Any) -> list[SearchResult]:
        logger.info("Executing DuckDuckGo Search for query: %s", query)
        try:
            with DDGS() as ddgs:
                # max_results=10 by default
                results_raw = list(ddgs.text(query, max_results=10))

            results = [
                SearchResult(
                    title=item.get("title", "No title"),
                    url=item.get("href", ""),
                    snippet=item.get("body", "No description"),
                    metadata=item,
                )
                for item in results_raw
            ]

            logger.info("Successfully retrieved %d search results", len(results))
            return results
        except Exception as e:
            logger.error("DuckDuckGo Search failed: %s", e)
            # Do not re-raise immediately if it fails?
            # Or maybe just log and re-raise.
            # The tool should handle errors.
            raise e

    async def asearch(self, query: str, **kwargs: Any) -> list[SearchResult]:
        return await asyncio.to_thread(self.search, query, **kwargs)
