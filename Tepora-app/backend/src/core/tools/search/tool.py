from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from ...common.pii_redactor import redact_pii
from ...config.loader import settings
from .base import SearchEngine

logger = logging.getLogger(__name__)


def _build_error_response(error_code: str, message: str, **kwargs: Any) -> str:
    response = {
        "error": True,
        "error_code": error_code,
        "message": message,
        **kwargs,
    }
    return json.dumps(response, ensure_ascii=False)


class SearchInput(BaseModel):
    query: str = Field(description="検索クエリ")


class SearchTool(BaseTool):
    name: str
    description: str
    args_schema: type[BaseModel] = SearchInput
    engine: SearchEngine = Field(description="Search engine implementation")

    def __init__(self, engine: SearchEngine, name: str, description: str, **kwargs: Any):
        super().__init__(name=name, description=description, engine=engine, **kwargs)

    def _make_error_response(self, error_code: str, message: str, **kwargs: Any) -> str:
        """Create a structured error response for frontend translation."""
        return _build_error_response(error_code, message, **kwargs)

    def _perform_search(self, query: str) -> str:
        if not settings.privacy.allow_web_search:
            return self._make_error_response(
                "search_disabled_privacy", "Web search is disabled by privacy settings."
            )

        # Apply PII redaction if enabled
        search_query = query
        redaction_count = 0
        if settings.privacy.redact_pii:
            search_query, redaction_count = redact_pii(query, enabled=True)
            if redaction_count > 0:
                logger.info("Redacted %d PII items from search query", redaction_count)

        start_time = time.time()
        try:
            results = self.engine.search(search_query)
            elapsed_time = time.time() - start_time
        except ValueError as exc:
            # Handle known configuration/API errors
            logger.error("Search engine error: %s", exc)
            return self._make_error_response("search_error", str(exc))
        except Exception as exc:
            logger.error("Unexpected error in search: %s", exc, exc_info=True)
            return self._make_error_response(
                "search_unexpected_error", f"Unexpected error occurred: {exc}", details=str(exc)
            )

        if not results:
            return f"No search results found for: {query}"

        # Format results (similar to existing Google tool output)
        formatted_results = [
            {
                "title": result.title,
                "url": result.url,
                "snippet": result.snippet,
            }
            for result in results
        ]

        response_payload = {
            "query": query,
            "effective_query": search_query,
            "redaction_count": redaction_count,
            "total_results": len(results),
            "results": formatted_results,
            "search_time": f"{elapsed_time:.2f}s",
            "engine": self.engine.name,
        }
        if redaction_count > 0:
            response_payload["notice"] = "Some sensitive items were redacted before search."

        return json.dumps(response_payload, ensure_ascii=False, indent=2)

    def _run(self, query: str) -> str:
        return self._perform_search(query)

    async def _arun(self, query: str) -> str:
        return await asyncio.to_thread(self._perform_search, query)
