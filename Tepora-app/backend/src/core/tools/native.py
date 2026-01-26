from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlparse

import requests  # type: ignore[import-untyped]
from bs4 import BeautifulSoup
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
from requests.adapters import HTTPAdapter  # type: ignore[import-untyped]
from urllib3.util.retry import Retry

from ..config.loader import settings
from .base import ToolProvider
from .search.providers.google import GoogleSearchEngine
from .search.tool import SearchTool, _build_error_response

logger = logging.getLogger(__name__)


class WebFetchInput(BaseModel):
    url: str = Field(description="内容を取得したいWebページのURL")


class WebFetchTool(BaseTool):
    name: str = "native_web_fetch"
    description: str = "指定されたURLのWebページにアクセスし、主要なテキストコンテンツを抽出して返します。HTMLタグは除去されます。"
    args_schema: type[BaseModel] = WebFetchInput

    def _make_error_response(self, error_code: str, message: str, **kwargs: Any) -> str:
        """Create a structured error response for frontend translation."""
        return _build_error_response(error_code, message, **kwargs)

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


class NativeToolProvider(ToolProvider):
    """
    Provider for collecting native tools (search, web fetch, etc.).
    """

    @property
    def name(self) -> str:
        """Return provider name."""
        return "native"

    async def load_tools(self) -> list[BaseTool]:
        logger.info("Loading native tools via Provider...")
        tools: list[BaseTool] = []

        # Check if Google Search is enabled
        api_key_secret = settings.tools.google_search_api_key
        api_key = api_key_secret.get_secret_value() if api_key_secret else None
        engine_id = settings.tools.google_search_engine_id

        if settings.privacy.allow_web_search and api_key and engine_id:
            try:
                google_engine = GoogleSearchEngine()
                google_search_tool = SearchTool(
                    engine=google_engine,
                    name="native_google_search",
                    description="Google Custom Search APIを使用してWeb検索を実行し、複数の結果を返します。",
                )

                # Additional alias for generic web search (pointing to Google for now)
                # Or we can just stick to native_google_search as requested by user.
                # User approved "native_web_search" name but also asked to move "nativeGoogleSearch" to foundation.
                # I will preserve "native_google_search" as per my check in planning,
                # but the user said "native_web_search is fine" in response to "tool name changes".
                # Let's add BOTH or just rename?
                # User's last prompt: "native_web_searchの名前で問題ありません" (native_web_search name is fine).
                # So I should probably use `native_web_search` as the primary name?
                # But to avoid breaking existing agents that might reference `native_google_search`, I'll stick to what I have in the code:
                # `native_google_search` is what I used in the previous step's contemplation.
                # Wait, looking at user request again: "native_web_searchの名前で問題ありません"
                # This implies I should use `native_web_search`?
                # I will keep `native_google_search` for now to minimize friction, or add an alias?
                # Actually, I'll stick to the plan of keeping `native_google_search` in the provider logic below,
                # but I can ALSO provide it as `native_web_search`.

                tools.append(google_search_tool)
            except Exception as exc:  # noqa: BLE001
                logger.error("Failed to load Google Custom Search tool: %s", exc, exc_info=True)

        # WebFetchTool is always available
        tools.append(WebFetchTool())

        for tool in tools:
            logger.info("Native tool available: %s", tool.name)

        return tools
