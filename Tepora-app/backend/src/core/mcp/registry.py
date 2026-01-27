"""
MCP Registry - Integration with Official MCP Server Registry.

Provides:
- Fetching server list from registry.modelcontextprotocol.io (v0.1)
- Offline fallback to seed.json
- Local caching mechanism
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path

import httpx
from packaging.version import InvalidVersion, Version

from .models import EnvVarSchema, McpRegistryServer, PackageInfo

logger = logging.getLogger(__name__)

# Official MCP Registry API
REGISTRY_API_URL = "https://registry.modelcontextprotocol.io/v0.1/servers"

# Cache duration (1 hour)
CACHE_DURATION = timedelta(hours=1)

# Official MCP Registry (v0.1) enforces `limit` in the range 1..100.
OFFICIAL_REGISTRY_MAX_LIMIT = 100

# Default page size when syncing the whole registry (cursor-based API).
# Official MCP Registry (v0.1) currently enforces `limit` in the range 1..100.
DEFAULT_API_LIMIT = OFFICIAL_REGISTRY_MAX_LIMIT

# Reduce duplicates by requesting only the latest version per server (official extension)
DEFAULT_VERSION_FILTER = "latest"


class McpRegistry:
    """
    Client for the official MCP server registry.

    Features:
    - Fetches available servers from the registry API
    - Falls back to local seed.json if API is unreachable
    - Caches results to minimize API calls
    """

    def __init__(self, seed_path: Path | None = None):
        """
        Initialize registry client.

        Args:
            seed_path: Path to seed.json for offline fallback.
                      If None, uses the default path in this package.
        """
        self.seed_path = seed_path or (Path(__file__).parent / "seed.json")
        self._cache: list[McpRegistryServer] = []
        self._cache_time: datetime | None = None
        self._http_client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        """Close HTTP client."""
        await self._http_client.aclose()

    async def fetch_servers(
        self,
        force_refresh: bool = False,
        search: str | None = None,
        version: str = DEFAULT_VERSION_FILTER,
    ) -> list[McpRegistryServer]:
        """
        Fetch available MCP servers from registry.

        Args:
            force_refresh: If True, bypass cache and fetch fresh data
            search: Optional case-insensitive substring match on server name (API-backed when uncached)
            version: Registry version filter (default: latest)

        Returns:
            List of available MCP servers
        """
        # Check cache
        if not force_refresh and self._is_cache_valid():
            logger.debug("Returning cached registry data")
            return self.search_servers_local(self._cache, search) if search else self._cache

        try:
            # Fetch a full list for a stable local cache, then apply search locally.
            servers = await self._fetch_from_api(search=None, version=version)
            self._update_cache(servers, version=version)
            logger.info("Fetched %d servers from registry API", len(servers))
            return self.search_servers_local(servers, search) if search else servers

        except Exception as e:
            logger.warning("Failed to fetch from registry API: %s", e, exc_info=True)
            seed_servers = await self._load_from_seed()
            self._update_cache(seed_servers, version=version)
            return self.search_servers_local(seed_servers, search) if search else seed_servers

    async def get_server_by_id(self, server_id: str) -> McpRegistryServer | None:
        """
        Get a specific server by its ID.

        Args:
            server_id: Server identifier

        Returns:
            Server info if found, None otherwise
        """
        servers = await self.fetch_servers()
        for server in servers:
            if server.id == server_id:
                return server
        return None

    async def search_servers(self, query: str) -> list[McpRegistryServer]:
        """
        Search servers by name or description.

        Args:
            query: Search query string

        Returns:
            List of matching servers
        """
        return await self.fetch_servers(search=query)

    @staticmethod
    def search_servers_local(
        servers: list[McpRegistryServer], query: str | None
    ) -> list[McpRegistryServer]:
        """Local fallback search used when results are already in-memory."""
        if not query:
            return servers
        query_lower = query.lower()
        return [
            server
            for server in servers
            if query_lower in server.name.lower()
            or (server.title and query_lower in server.title.lower())
            or (server.description and query_lower in server.description.lower())
            or query_lower in server.id.lower()
        ]

    def refresh_cache(self) -> None:
        """Invalidate cache to force refresh on next fetch."""
        self._cache = []
        self._cache_time = None
        logger.info("Registry cache invalidated")

    def _is_cache_valid(self) -> bool:
        """Check if cache is still valid."""
        if not self._cache or not self._cache_time:
            return False
        return datetime.now() - self._cache_time < CACHE_DURATION

    def _update_cache(self, servers: list[McpRegistryServer], *, version: str) -> None:
        if version != DEFAULT_VERSION_FILTER:
            return
        self._cache = servers
        self._cache_time = datetime.now()

    async def _fetch_from_api(
        self,
        *,
        search: str | None = None,
        version: str = DEFAULT_VERSION_FILTER,
        limit: int = DEFAULT_API_LIMIT,
    ) -> list[McpRegistryServer]:
        """Fetch servers from the registry API (cursor-based pagination)."""
        limit = max(1, min(limit, OFFICIAL_REGISTRY_MAX_LIMIT))
        servers: list[McpRegistryServer] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()

        while True:
            params: dict[str, str | int] = {"limit": limit, "version": version}
            if cursor:
                # Protect against buggy/unchanged cursors causing infinite loops
                if cursor in seen_cursors:
                    logger.warning("Registry pagination cursor repeated; stopping pagination")
                    break
                seen_cursors.add(cursor)
                params["cursor"] = cursor
            if search:
                params["search"] = search

            response = await self._http_client.get(REGISTRY_API_URL, params=params)
            response.raise_for_status()

            data = response.json()

            # Parse servers from response
            for item in data.get("servers", []):
                try:
                    # 新しいAPI形式: {"server": {...}, "_meta": {...}}
                    server_data = item.get("server", item)
                    server = self._parse_server(server_data)
                    servers.append(server)
                except Exception as e:
                    logger.warning("Failed to parse server: %s", e, exc_info=True)

            # Check for pagination
            metadata = data.get("metadata") or {}
            cursor = metadata.get("nextCursor") or data.get("nextCursor")
            if not cursor:
                break

        return self._dedupe_latest(servers)

    async def _load_from_seed(self) -> list[McpRegistryServer]:
        """Load servers from local seed.json file."""
        if not self.seed_path.exists():
            logger.warning("Seed file not found: %s", self.seed_path)
            return []

        try:
            data = json.loads(self.seed_path.read_text(encoding="utf-8"))

            servers: list[McpRegistryServer] = []

            # Supported seed formats:
            # 1) Legacy Tepora seed.json: {"servers": [ {id,name,packages,environmentVariables,...} ]}
            # 2) Official registry seed.json (examples): [ {name,description,version,packages:[...]} ]
            # 3) Registry API list response: {"servers":[{"server":{...}}], "metadata":{...}}
            if isinstance(data, dict) and isinstance(data.get("servers"), list):
                for item in data.get("servers", []):
                    try:
                        server_data = item.get("server", item) if isinstance(item, dict) else item
                        server = self._parse_server(server_data)
                        servers.append(server)
                    except Exception as e:
                        logger.warning("Failed to parse seed server: %s", e, exc_info=True)
            elif isinstance(data, list):
                for item in data:
                    try:
                        if not isinstance(item, dict):
                            continue
                        server = self._parse_server(item)
                        servers.append(server)
                    except Exception as e:
                        logger.warning("Failed to parse seed server: %s", e, exc_info=True)
            else:
                logger.warning("Unsupported seed.json format: %s", type(data))
                return []

            servers = self._dedupe_latest(servers)
            logger.info("Loaded %d servers from seed file", len(servers))
            return servers

        except Exception as e:
            logger.error("Failed to load seed file: %s", e, exc_info=True)
            return []

    def _parse_server(self, data: dict) -> McpRegistryServer:
        """Parse a server from API/seed data (supports legacy and v0.1 schema)."""

        server_name = data.get("name", "") or data.get("id", "")
        server_id = data.get("id") or server_name
        title = data.get("title")
        description = data.get("description")
        version = data.get("version")

        # Packages (legacy: {name, registry}; v0.1: {identifier, registryType})
        packages: list[PackageInfo] = []
        for pkg in data.get("packages", []) or []:
            if not isinstance(pkg, dict):
                continue

            # Ensure runtimeHint exists as much as possible (used by installer/UI).
            runtime_hint = pkg.get("runtimeHint")
            registry_type = pkg.get("registryType") or pkg.get("registry")
            if not runtime_hint and isinstance(registry_type, str):
                runtime_hint = {
                    "npm": "npx",
                    "pypi": "uvx",
                    "oci": "docker",
                    "nuget": "dnx",
                }.get(registry_type)

            pkg_normalized = {**pkg}
            if runtime_hint:
                pkg_normalized["runtimeHint"] = runtime_hint

            try:
                packages.append(PackageInfo.model_validate(pkg_normalized))
            except Exception as e:
                logger.debug("Failed to parse package for %s: %s", server_id, e)

        # Environment variables:
        # - legacy: server-level `environmentVariables`
        # - v0.1: per-package `environmentVariables` (KeyValueInput)
        env_by_name: dict[str, EnvVarSchema] = {}

        def _merge_env(env: EnvVarSchema) -> None:
            existing = env_by_name.get(env.name)
            if not existing:
                env_by_name[env.name] = env
                return
            env_by_name[env.name] = EnvVarSchema(
                name=env.name,
                description=existing.description or env.description,
                isRequired=bool(existing.isRequired or env.isRequired),
                isSecret=bool(existing.isSecret or env.isSecret),
                default=existing.default or env.default,
            )

        for env in data.get("environmentVariables", []) or []:
            if not isinstance(env, dict):
                continue
            try:
                _merge_env(EnvVarSchema.model_validate(env))
            except Exception as exc:
                logger.debug("Failed to parse env var schema: %s", exc, exc_info=True)
                continue

        for pkg in packages:
            for env in pkg.environmentVariables or []:
                _merge_env(env)

        # repository/source URL (v0.1: repository.url; legacy: sourceUrl)
        repository = data.get("repository", {})
        source_url = data.get("sourceUrl") or (
            repository.get("url") if isinstance(repository, dict) else None
        )

        # Best-effort icon selection (v0.1: icons[].src; legacy: icon)
        icon = data.get("icon")
        if not icon and isinstance(data.get("icons"), list) and data["icons"]:
            first_icon = data["icons"][0]
            if isinstance(first_icon, dict):
                icon = first_icon.get("src")

        homepage = data.get("homepage") or data.get("websiteUrl")

        # Prefer title for display, but keep stable ID separately.
        display_name = title or server_name

        return McpRegistryServer(
            id=server_id,
            name=display_name,
            title=title,
            version=version,
            description=description,
            vendor=data.get("vendor"),
            sourceUrl=source_url,
            homepage=homepage,
            websiteUrl=data.get("websiteUrl"),
            license=data.get("license"),
            packages=packages,
            environmentVariables=list(env_by_name.values()),
            icon=icon,
            category=data.get("category"),
        )

    @staticmethod
    def _dedupe_latest(servers: list[McpRegistryServer]) -> list[McpRegistryServer]:
        """Dedupe servers by ID, keeping the highest semantic version when available."""
        latest_by_id: dict[str, McpRegistryServer] = {}

        def _parse_version(raw: str | None) -> Version | None:
            if not raw:
                return None
            try:
                return Version(raw)
            except InvalidVersion:
                return None

        for server in servers:
            existing = latest_by_id.get(server.id)
            if not existing:
                latest_by_id[server.id] = server
                continue

            current_v = _parse_version(server.version)
            existing_v = _parse_version(existing.version)

            if current_v is None and existing_v is None:
                # No reliable ordering; keep the first.
                continue
            if existing_v is None:
                latest_by_id[server.id] = server
                continue
            if current_v is None:
                continue
            if current_v > existing_v:
                latest_by_id[server.id] = server

        return list(latest_by_id.values())
