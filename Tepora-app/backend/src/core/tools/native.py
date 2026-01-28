from __future__ import annotations

import asyncio
import logging
import socket
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
from .search.base import SearchEngine
from .search.providers.google import GoogleSearchEngine
from .search.tool import SearchTool, _build_error_response

try:
    from .search.providers.duckduckgo import DuckDuckGoSearchEngine

    HAS_DDG = True
except ImportError:
    HAS_DDG = False

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

        # Get URL denylist from settings.privacy
        denylist = settings.privacy.url_denylist

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
            # DNS Resolution
            try:
                # Use socket.getaddrinfo to resolve (supports IPv4/IPv6)
                # We check ALL resolved IPs
                addr_infos = socket.getaddrinfo(host, None)
                ips = {info[4][0] for info in addr_infos}
            except socket.gaierror:
                # If DNS resolution fails, it might be an internal name or just invalid.
                # Conservatively, if it's not a valid public hostname we can reach, we might allow it?
                # No, if we can't resolve it, requests will fail anyway.
                # But sticking to "safe" side, we pass here and let requests fail or succeed if it's a weird internal DNS.
                # Wait, if it's internal DNS resolving to private IP, getaddrinfo SHOULD return it.
                # If it fails, maybe it's not reachable.
                # Let's just catch and ignore here, or treat as error?
                # Standard practice: if invalid, requests raises error.
                pass
            else:
                for ip_str in ips:
                    ip = ipaddress.ip_address(ip_str)
                    if ip.is_private or ip.is_loopback or ip.is_link_local:
                        logger.warning("URL blocked: %s resolves to private IP %s", url, ip)
                        return self._make_error_response(
                            "url_blocked_private_ip",
                            "Access to private/local IP addresses is blocked for security reasons.",
                        )

        except ValueError:
            # Not an IP address, that's fine
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

        # Check configured search provider
        if settings.privacy.allow_web_search:
            search_engine: SearchEngine | None = None
            provider = settings.tools.search_provider

            try:
                if provider == "google":
                    api_key_secret = settings.tools.google_search_api_key
                    api_key = api_key_secret.get_secret_value() if api_key_secret else None
                    engine_id = settings.tools.google_search_engine_id

                    if api_key and engine_id:
                        search_engine = GoogleSearchEngine()
                    else:
                        logger.warning("Google Search selected but keys are missing.")

                elif provider == "duckduckgo":
                    if HAS_DDG:
                        search_engine = DuckDuckGoSearchEngine()
                    else:
                        logger.error(
                            "DuckDuckGo Search selected but duckduckgo-search package is missing."
                        )

                if search_engine:
                    # Primary tool name: native_web_search
                    web_search_tool = SearchTool(
                        engine=search_engine,
                        name="native_web_search",
                        description=f"{provider.capitalize()} Searchを使用してWeb検索を実行し、複数の結果を返します。",
                    )
                    tools.append(web_search_tool)

                    # Legacy alias: native_google_search (points to the same engine)
                    # Maintains compatibility with prompts asking for 'native_google_search'
                    legacy_tool = SearchTool(
                        engine=search_engine,
                        name="native_google_search",
                        description=f"(Legacy Alias) {provider.capitalize()} Searchを使用してWeb検索を実行します。",
                    )
                    tools.append(legacy_tool)

            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "Failed to load search tool (%s): %s", provider, exc, exc_info=True
                )

        if settings.privacy.allow_web_search:
            # WebFetchTool is only available if privacy settings allow it
            # Reusing allow_web_search since it conceptually covers "external network access" for now
            # as per P0-2 fix plan.
            tools.append(WebFetchTool())
        else:
            logger.info("WebFetchTool disabled by privacy settings (allow_web_search=False)")

        for tool in tools:
            logger.info("Native tool available: %s", tool.name)

        return tools
