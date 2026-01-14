from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from ..common.pii_redactor import redact_pii
from ..config.loader import settings

logger = logging.getLogger(__name__)


class GoogleCustomSearchInput(BaseModel):
    query: str = Field(description="検索クエリ")


class GoogleCustomSearchTool(BaseTool):
    name: str = "native_google_search"
    description: str = "Google Custom Search APIを使用してWeb検索を実行し、複数の結果を返します。"
    args_schema: type[BaseModel] = GoogleCustomSearchInput
    session: Any = Field(None, exclude=True)

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)

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
        session.timeout = (10, 30)
        return session

    def _make_error_response(self, error_code: str, message: str, **kwargs: Any) -> str:
        """Create a structured error response for frontend translation."""
        response = {
            "error": True,
            "error_code": error_code,
            "message": message,
            **kwargs,
        }
        return json.dumps(response, ensure_ascii=False)

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

        api_key = settings.tools.google_search_api_key
        engine_id = settings.tools.google_search_engine_id

        if not api_key or not engine_id:
            return self._make_error_response(
                "search_disabled_api_keys",
                "Google Custom Search is disabled (API keys not configured).",
            )

        url = "https://www.googleapis.com/customsearch/v1"
        params = {
            "key": api_key,
            "cx": engine_id,
            "q": search_query,
            "num": 10,
            "safe": "active",
        }
        headers = {
            "User-Agent": "AI-Agent/1.0 (Google Custom Search Tool)",
            "Accept": "application/json",
        }

        logger.info("Executing Google Custom Search for query: %s", search_query)
        start_time = time.time()
        try:
            with self._create_session() as session:
                response = session.get(url, params=params, headers=headers, timeout=(10, 30))
            elapsed_time = time.time() - start_time
            logger.info("Search completed in %.2f seconds", elapsed_time)
            response.raise_for_status()
            data = response.json()
        except requests.exceptions.Timeout as exc:  # noqa: PERF203
            logger.error("Google Custom Search API timeout: %s", exc)
            return self._make_error_response(
                "search_timeout", "Search request timed out. Please try again later."
            )
        except requests.exceptions.ConnectionError as exc:
            logger.error("Google Custom Search API connection error: %s", exc)
            return self._make_error_response(
                "search_connection_error",
                "Connection failed. Please check your internet connection and try again.",
            )
        except requests.exceptions.HTTPError as exc:
            status_code = exc.response.status_code if exc.response else "N/A"
            logger.error("Google Custom Search API HTTP error: Status %s", status_code)
            if status_code == 429:
                return self._make_error_response(
                    "search_rate_limit", "Rate limit exceeded. Please wait a moment and try again."
                )
            if status_code == 403:
                return self._make_error_response(
                    "search_access_denied",
                    "API access denied. Please check your API key and permissions.",
                )
            return self._make_error_response(
                "search_http_error",
                f"HTTP error occurred with status code {status_code}.",
                status_code=str(status_code),
            )
        except requests.exceptions.RequestException as exc:
            logger.error("Google Custom Search API request failed: %s", exc)
            return self._make_error_response(
                "search_failed", f"Failed to perform search: {exc}", details=str(exc)
            )
        except json.JSONDecodeError as exc:
            logger.error("Failed to parse Google API response: %s", exc)
            return self._make_error_response(
                "search_invalid_response", "Invalid response from Google API. Please try again."
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Unexpected error in Google Custom Search: %s", exc, exc_info=True)
            return self._make_error_response(
                "search_unexpected_error", f"Unexpected error occurred: {exc}", details=str(exc)
            )

        if "error" in data:
            error_info = data["error"]
            error_message = f"Google API Error: {error_info.get('code', 'Unknown')} - {error_info.get('message', 'Unknown error')}"
            logger.error(error_message)
            return self._make_error_response(
                "search_api_error", error_message, api_code=error_info.get("code", "Unknown")
            )

        items = data.get("items")
        if not items:
            return f"No search results found for: {query}"

        results = [
            {
                "title": item.get("title", "No title"),
                "url": item.get("link", ""),
                "snippet": item.get("snippet", "No description"),
            }
            for item in items
        ]
        logger.info("Successfully retrieved %d search results", len(results))
        response_payload = {
            "query": query,
            "effective_query": search_query,
            "redaction_count": redaction_count,
            "total_results": len(results),
            "results": results,
            "search_time": f"{elapsed_time:.2f}s",
        }
        if redaction_count > 0:
            response_payload["notice"] = "Some sensitive items were redacted before search."

        return json.dumps(response_payload, ensure_ascii=False, indent=2)

    def _run(self, query: str) -> str:
        return self._perform_search(query)

    async def _arun(self, query: str) -> str:
        return await asyncio.to_thread(self._perform_search, query)


class WebFetchInput(BaseModel):
    url: str = Field(description="内容を取得したいWebページのURL")


class WebFetchTool(BaseTool):
    name: str = "native_web_fetch"
    description: str = "指定されたURLのWebページにアクセスし、主要なテキストコンテンツを抽出して返します。HTMLタグは除去されます。"
    args_schema: type[BaseModel] = WebFetchInput

    def _make_error_response(self, error_code: str, message: str, **kwargs: Any) -> str:
        """Create a structured error response for frontend translation."""
        response = {
            "error": True,
            "error_code": error_code,
            "message": message,
            **kwargs,
        }
        return json.dumps(response, ensure_ascii=False)

    def _create_session(self) -> requests.Session:
        session = requests.Session()
        retry_strategy = Retry(total=2, backoff_factor=1, status_forcelist=[429, 502, 503, 504])
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        session.headers.update({"User-Agent": "AI-Agent/1.0 (WebFetchTool)"})
        return session

    def _validate_url(self, url: str) -> str | None:
        """Validate URL format and check against denylist."""
        import fnmatch
        import ipaddress

        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return self._make_error_response(
                "url_invalid_scheme", "URL must include a valid http/https scheme and host."
            )

        # Get host (without port), handling IPv6 literals correctly
        host = (parsed.hostname or "").lower()
        if not host:
            return self._make_error_response(
                "url_no_hostname", "Could not determine hostname from URL."
            )

        # Get URL denylist from config schema (externalized from hardcoded values)
        from ..config.schema import AgentToolPolicyConfig

        denylist = AgentToolPolicyConfig().url_denylist

        # Check denylist patterns
        for pattern in denylist:
            if fnmatch.fnmatch(host, pattern):
                logger.warning("URL blocked by denylist: %s (matched pattern: %s)", url, pattern)
                return self._make_error_response(
                    "url_blocked_private",
                    f"Access to {host} is blocked for security reasons (private/local network).",
                    host=host,
                )

        # Additional check: resolve hostname and check if it's a private IP
        try:
            # Try to parse as IP address directly
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                logger.warning("URL blocked: %s resolves to private IP %s", url, ip)
                return self._make_error_response(
                    "url_blocked_private_ip",
                    "Access to private/local IP addresses is blocked for security reasons.",
                )
        except ValueError:
            # Not an IP address, that's fine - it's a hostname
            pass

        return None

    def _fetch_content(self, url: str) -> str:
        validation_error = self._validate_url(url)
        if validation_error:
            logger.warning("WebFetch validation failed for URL '%s': %s", url, validation_error)
            return validation_error

        with self._create_session() as session:
            try:
                logger.info("Fetching content from URL: %s", url)
                response = session.get(url, timeout=(10, 20))
                response.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                logger.error("Failed to retrieve URL %s: %s", url, exc, exc_info=True)
                return self._make_error_response(
                    "fetch_failed",
                    f"Failed to retrieve content from {url}.",
                    url=url,
                    details=str(exc),
                )

        content_type = response.headers.get("Content-Type", "")
        if "text/html" not in content_type:
            return self._make_error_response(
                "fetch_not_html", "URL is not an HTML page.", content_type=content_type
            )

        soup = BeautifulSoup(response.text, "html.parser")
        for element in soup(["script", "style", "header", "footer", "nav", "aside"]):
            element.decompose()

        text = soup.get_text()
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        cleaned_text = "\n".join(chunk for chunk in chunks if chunk)

        # Limit to configured characters to prevent embedding server overload
        max_chars = settings.app.web_fetch_max_chars
        if len(cleaned_text) > max_chars:
            cleaned_text = cleaned_text[:max_chars] + "\n\n... (content truncated)"

        return cleaned_text

    def _run(self, url: str) -> str:
        return self._fetch_content(url)

    async def _arun(self, url: str) -> str:
        return await asyncio.to_thread(self._fetch_content, url)


from .base import ToolProvider  # noqa: E402


class NativeToolProvider(ToolProvider):
    """
    Provider for collecting native tools (search, web fetch, etc.).
    """

    async def load_tools(self) -> list[BaseTool]:
        logger.info("Loading native tools via Provider...")
        tools: list[BaseTool] = []

        # Check if Google Search is enabled
        api_key = settings.tools.google_search_api_key
        engine_id = settings.tools.google_search_engine_id

        if settings.privacy.allow_web_search and api_key and engine_id:
            try:
                google_search_tool = GoogleCustomSearchTool()
                google_search_tool.name = "native_google_search"
                google_search_tool.description = "Search the web with Google Custom Search API and return multiple results (list of findings). This is a native tool."
                tools.append(google_search_tool)
            except Exception as exc:  # noqa: BLE001
                logger.error("Failed to load Google Custom Search tool: %s", exc, exc_info=True)

        # WebFetchTool is always available
        tools.append(WebFetchTool())

        for tool in tools:
            logger.info("Native tool available: %s", tool.name)

        return tools
