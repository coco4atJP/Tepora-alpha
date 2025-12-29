"""
MCP Registry - Integration with Official MCP Server Registry.

Provides:
- Fetching server list from registry.modelcontextprotocol.io
- Offline fallback to seed.json
- Local caching mechanism
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import List, Optional
from datetime import datetime, timedelta

import httpx

from .models import McpRegistryServer, PackageInfo, EnvVarSchema

logger = logging.getLogger(__name__)

# Official MCP Registry API
REGISTRY_API_URL = "https://registry.modelcontextprotocol.io/v0/servers"

# Cache duration (1 hour)
CACHE_DURATION = timedelta(hours=1)


class McpRegistry:
    """
    Client for the official MCP server registry.
    
    Features:
    - Fetches available servers from the registry API
    - Falls back to local seed.json if API is unreachable
    - Caches results to minimize API calls
    """
    
    def __init__(self, seed_path: Optional[Path] = None):
        """
        Initialize registry client.
        
        Args:
            seed_path: Path to seed.json for offline fallback.
                      If None, uses the default path in this package.
        """
        self.seed_path = seed_path or (Path(__file__).parent / "seed.json")
        self._cache: List[McpRegistryServer] = []
        self._cache_time: Optional[datetime] = None
        self._http_client = httpx.AsyncClient(timeout=30.0)
        
    async def close(self) -> None:
        """Close HTTP client."""
        await self._http_client.aclose()
        
    async def fetch_servers(self, force_refresh: bool = False) -> List[McpRegistryServer]:
        """
        Fetch available MCP servers from registry.
        
        Args:
            force_refresh: If True, bypass cache and fetch fresh data
            
        Returns:
            List of available MCP servers
        """
        # Check cache
        if not force_refresh and self._is_cache_valid():
            logger.debug("Returning cached registry data")
            return self._cache
            
        try:
            servers = await self._fetch_from_api()
            self._cache = servers
            self._cache_time = datetime.now()
            logger.info("Fetched %d servers from registry API", len(servers))
            return servers
            
        except Exception as e:
            logger.warning("Failed to fetch from registry API: %s", e)
            return await self._load_from_seed()
            
    async def get_server_by_id(self, server_id: str) -> Optional[McpRegistryServer]:
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
        
    async def search_servers(self, query: str) -> List[McpRegistryServer]:
        """
        Search servers by name or description.
        
        Args:
            query: Search query string
            
        Returns:
            List of matching servers
        """
        servers = await self.fetch_servers()
        query_lower = query.lower()
        
        results = []
        for server in servers:
            if (query_lower in server.name.lower() or 
                (server.description and query_lower in server.description.lower())):
                results.append(server)
                
        return results
        
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
        
    async def _fetch_from_api(self) -> List[McpRegistryServer]:
        """Fetch servers from the registry API."""
        servers: List[McpRegistryServer] = []
        cursor: Optional[str] = None
        
        while True:
            url = REGISTRY_API_URL
            if cursor:
                url = f"{url}?cursor={cursor}"
                
            response = await self._http_client.get(url)
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
                    logger.warning("Failed to parse server: %s", e)
                    
            # Check for pagination
            cursor = data.get("nextCursor")
            if not cursor:
                break
                
        return servers
        
    async def _load_from_seed(self) -> List[McpRegistryServer]:
        """Load servers from local seed.json file."""
        if not self.seed_path.exists():
            logger.warning("Seed file not found: %s", self.seed_path)
            return []
            
        try:
            data = json.loads(self.seed_path.read_text(encoding="utf-8"))
            servers = []
            
            for item in data.get("servers", []):
                try:
                    server = self._parse_server(item)
                    servers.append(server)
                except Exception as e:
                    logger.warning("Failed to parse seed server: %s", e)
                    
            logger.info("Loaded %d servers from seed file", len(servers))
            return servers
            
        except Exception as e:
            logger.error("Failed to load seed file: %s", e)
            return []
            
    def _parse_server(self, data: dict) -> McpRegistryServer:
        """Parse a server from API/seed data."""
        packages = []
        for pkg in data.get("packages", []):
            packages.append(PackageInfo(
                name=pkg.get("name", ""),
                version=pkg.get("version"),
                registry=pkg.get("registry"),
                runtimeHint=pkg.get("runtimeHint"),
            ))
            
        env_vars = []
        for env in data.get("environmentVariables", []):
            env_vars.append(EnvVarSchema(
                name=env.get("name", ""),
                description=env.get("description"),
                isRequired=env.get("isRequired", False),
                isSecret=env.get("isSecret", False),
                default=env.get("default"),
            ))
        
        # 新しいAPI形式: repositoryからsourceUrlを取得
        repository = data.get("repository", {})
        source_url = data.get("sourceUrl") or (repository.get("url") if isinstance(repository, dict) else None)
            
        return McpRegistryServer(
            id=data.get("id", data.get("name", "")),
            name=data.get("name", ""),
            description=data.get("description"),
            vendor=data.get("vendor"),
            sourceUrl=source_url,
            homepage=data.get("homepage"),
            license=data.get("license"),
            packages=packages,
            environmentVariables=env_vars,
            icon=data.get("icon"),
            category=data.get("category"),
        )
