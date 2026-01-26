from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import requests  # type: ignore[import-untyped]
from requests.adapters import HTTPAdapter  # type: ignore[import-untyped]
from urllib3.util.retry import Retry

from ....config.loader import settings
from ..base import SearchEngine, SearchResult

logger = logging.getLogger(__name__)


class GoogleSearchEngine(SearchEngine):
    """Google Custom Search API implementation."""

    @property
    def name(self) -> str:
        return "google"

    def _create_session(self) -> requests.Session:
        session = requests.Session()
        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"],
        )
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        return session

    def search(self, query: str, **kwargs: Any) -> list[SearchResult]:
        api_key_secret = settings.tools.google_search_api_key
        api_key = api_key_secret.get_secret_value() if api_key_secret else None
        engine_id = settings.tools.google_search_engine_id

        if not api_key or not engine_id:
            raise ValueError("Google Custom Search API keys not configured.")

        url = "https://www.googleapis.com/customsearch/v1"
        params = {
            "key": api_key,
            "cx": engine_id,
            "q": query,
            "num": 10,
            "safe": "active",
            **kwargs,
        }
        headers = {
            "User-Agent": "AI-Agent/1.0 (Google Custom Search Tool)",
            "Accept": "application/json",
        }

        logger.info("Executing Google Custom Search for query: %s", query)
        start_time = time.time()

        with self._create_session() as session:
            try:
                response = session.get(url, params=params, headers=headers, timeout=(10, 30))
                elapsed_time = time.time() - start_time
                logger.info("Search completed in %.2f seconds", elapsed_time)
                response.raise_for_status()
                data = response.json()
            except Exception as e:
                logger.error("Google Search failed: %s", e)
                raise e

        if "error" in data:
            error_info = data["error"]
            error_message = f"Google API Error: {error_info.get('code', 'Unknown')} - {error_info.get('message', 'Unknown error')}"
            logger.error(error_message)
            raise ValueError(error_message)

        items = data.get("items", [])
        results = [
            SearchResult(
                title=item.get("title", "No title"),
                url=item.get("link", ""),
                snippet=item.get("snippet", "No description"),
                metadata=item,
            )
            for item in items
        ]

        logger.info("Successfully retrieved %d search results", len(results))
        return results

    async def asearch(self, query: str, **kwargs: Any) -> list[SearchResult]:
        return await asyncio.to_thread(self.search, query, **kwargs)
