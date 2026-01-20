"""
Tests for MCP Registry.

Tests:
- Seed file loading and parsing
- Server search functionality
- Cache behavior
- API fallback to seed.json
"""

import json
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from src.core.mcp.models import McpRegistryServer
from src.core.mcp.registry import CACHE_DURATION, McpRegistry


@pytest.fixture
def sample_seed_data() -> dict:
    """Sample seed.json data for testing."""
    return {
        "servers": [
            {
                "id": "filesystem",
                "name": "@modelcontextprotocol/server-filesystem",
                "description": "Secure file operations with configurable access controls",
                "vendor": "Anthropic",
                "sourceUrl": "https://github.com/modelcontextprotocol/servers",
                "packages": [
                    {
                        "name": "@modelcontextprotocol/server-filesystem",
                        "registry": "npm",
                        "runtimeHint": "npx",
                    }
                ],
                "environmentVariables": [],
            },
            {
                "id": "fetch",
                "name": "@modelcontextprotocol/server-fetch",
                "description": "Web content fetching and conversion for efficient LLM usage",
                "vendor": "Anthropic",
                "sourceUrl": "https://github.com/modelcontextprotocol/servers",
                "packages": [
                    {
                        "name": "@modelcontextprotocol/server-fetch",
                        "registry": "npm",
                        "runtimeHint": "npx",
                    }
                ],
                "environmentVariables": [],
            },
            {
                "id": "github",
                "name": "@modelcontextprotocol/server-github",
                "description": "GitHub API integration for repository management",
                "vendor": "Anthropic",
                "packages": [
                    {
                        "name": "@modelcontextprotocol/server-github",
                        "registry": "npm",
                        "runtimeHint": "npx",
                    }
                ],
                "environmentVariables": [
                    {
                        "name": "GITHUB_PERSONAL_ACCESS_TOKEN",
                        "description": "GitHub Personal Access Token for API authentication",
                        "isRequired": True,
                        "isSecret": True,
                    }
                ],
            },
        ]
    }


@pytest.fixture
def temp_seed_file(tmp_path: Path, sample_seed_data: dict) -> Path:
    """Create a temporary seed.json file for testing."""
    seed_path = tmp_path / "seed.json"
    seed_path.write_text(json.dumps(sample_seed_data), encoding="utf-8")
    return seed_path


class TestMcpRegistrySeeding:
    """Test seed file loading functionality."""

    @pytest.mark.asyncio
    async def test_load_from_seed_success(self, temp_seed_file: Path, sample_seed_data: dict):
        """Verify seed.json is loaded and parsed correctly."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            assert len(servers) == len(sample_seed_data["servers"])
            assert servers[0].id == "filesystem"
            assert servers[1].id == "fetch"
            assert servers[2].id == "github"
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_load_from_seed_missing_file(self, tmp_path: Path):
        """Verify graceful handling when seed file is missing."""
        registry = McpRegistry(seed_path=tmp_path / "nonexistent.json")
        try:
            servers = await registry._load_from_seed()
            assert servers == []
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_load_from_seed_invalid_json(self, tmp_path: Path):
        """Verify graceful handling of invalid JSON."""
        bad_seed = tmp_path / "bad_seed.json"
        bad_seed.write_text("not valid json {", encoding="utf-8")

        registry = McpRegistry(seed_path=bad_seed)
        try:
            servers = await registry._load_from_seed()
            assert servers == []
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_parse_server_with_env_vars(self, temp_seed_file: Path, sample_seed_data: dict):
        """Verify environment variables are parsed correctly."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            github_server = next(s for s in servers if s.id == "github")
            assert len(github_server.environmentVariables) == 1
            env_var = github_server.environmentVariables[0]
            assert env_var.name == "GITHUB_PERSONAL_ACCESS_TOKEN"
            assert env_var.isRequired is True
            assert env_var.isSecret is True
        finally:
            await registry.close()


class TestMcpRegistrySearch:
    """Test server search functionality."""

    @pytest.mark.asyncio
    async def test_search_by_name(self, temp_seed_file: Path):
        """Search servers by name substring."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            result = McpRegistry.search_servers_local(servers, "filesystem")
            assert len(result) == 1
            assert result[0].id == "filesystem"
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_search_by_description(self, temp_seed_file: Path):
        """Search servers by description."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            result = McpRegistry.search_servers_local(servers, "github")
            assert len(result) == 1
            assert result[0].id == "github"
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_search_case_insensitive(self, temp_seed_file: Path):
        """Search is case-insensitive."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            result = McpRegistry.search_servers_local(servers, "FILESYSTEM")
            assert len(result) == 1
            assert result[0].id == "filesystem"
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_search_partial_match(self, temp_seed_file: Path):
        """Search matches partial strings."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            result = McpRegistry.search_servers_local(servers, "server")
            # All servers have "server" in their name
            assert len(result) == 3
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_search_no_results(self, temp_seed_file: Path):
        """Search with no matches returns empty list."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            result = McpRegistry.search_servers_local(servers, "nonexistent")
            assert result == []
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_search_empty_query(self, temp_seed_file: Path):
        """Empty search query returns all servers."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            result = McpRegistry.search_servers_local(servers, "")
            assert len(result) == 3
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_search_none_query(self, temp_seed_file: Path):
        """None search query returns all servers."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            result = McpRegistry.search_servers_local(servers, None)
            assert len(result) == 3
        finally:
            await registry.close()


class TestMcpRegistryCache:
    """Test caching functionality."""

    @pytest.mark.asyncio
    async def test_cache_is_used(self, temp_seed_file: Path):
        """Verify cache is used on subsequent calls."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            # Manually populate cache
            servers = await registry._load_from_seed()
            registry._cache = servers
            registry._cache_time = datetime.now()

            # Call fetch_servers - should use cache
            with patch.object(registry, "_fetch_from_api") as mock_api:
                with patch.object(registry, "_load_from_seed") as mock_seed:
                    result = await registry.fetch_servers()
                    mock_api.assert_not_called()
                    mock_seed.assert_not_called()
                    assert len(result) == 3
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_cache_expiry(self, temp_seed_file: Path):
        """Verify cache is invalidated after expiry."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            # Set expired cache time
            servers = await registry._load_from_seed()
            registry._cache = servers
            registry._cache_time = datetime.now() - CACHE_DURATION - timedelta(seconds=1)

            # Should not be valid
            assert not registry._is_cache_valid()
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_force_refresh_bypasses_cache(self, temp_seed_file: Path):
        """force_refresh=True should bypass the cache."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            # Populate cache
            servers = await registry._load_from_seed()
            registry._cache = servers
            registry._cache_time = datetime.now()

            # Mock API to fail so seed is used
            with patch.object(registry, "_fetch_from_api", new_callable=AsyncMock) as mock_api:
                mock_api.side_effect = httpx.HTTPError("API unavailable")

                result = await registry.fetch_servers(force_refresh=True)
                mock_api.assert_called_once()
                assert len(result) == 3  # Falls back to seed
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_refresh_cache_invalidates(self, temp_seed_file: Path):
        """refresh_cache() should invalidate the cache."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            registry._cache = servers
            registry._cache_time = datetime.now()

            assert registry._is_cache_valid()
            registry.refresh_cache()
            assert not registry._is_cache_valid()
        finally:
            await registry.close()


class TestMcpRegistryApiFallback:
    """Test API fallback to seed.json."""

    @pytest.mark.asyncio
    async def test_api_failure_falls_back_to_seed(self, temp_seed_file: Path):
        """When API fails, seed.json should be used."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            with patch.object(registry, "_fetch_from_api", new_callable=AsyncMock) as mock_api:
                mock_api.side_effect = httpx.HTTPError("Network error")

                result = await registry.fetch_servers()
                assert len(result) == 3
                assert result[0].id == "filesystem"
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_api_success_uses_api_data(self, temp_seed_file: Path):
        """When API succeeds, API data should be used."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            api_servers = [
                McpRegistryServer(
                    id="api-server",
                    name="API Server",
                    description="From API",
                )
            ]

            with patch.object(registry, "_fetch_from_api", new_callable=AsyncMock) as mock_api:
                mock_api.return_value = api_servers

                result = await registry.fetch_servers()
                assert len(result) == 1
                assert result[0].id == "api-server"
        finally:
            await registry.close()


class TestMcpRegistryGetById:
    """Test get_server_by_id functionality."""

    @pytest.mark.asyncio
    async def test_get_existing_server(self, temp_seed_file: Path):
        """Get server by ID when it exists."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            # Populate cache
            with patch.object(registry, "_fetch_from_api", new_callable=AsyncMock) as mock_api:
                mock_api.side_effect = httpx.HTTPError("API unavailable")

                result = await registry.get_server_by_id("filesystem")
                assert result is not None
                assert result.id == "filesystem"
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_get_nonexistent_server(self, temp_seed_file: Path):
        """Get server by ID when it doesn't exist."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            with patch.object(registry, "_fetch_from_api", new_callable=AsyncMock) as mock_api:
                mock_api.side_effect = httpx.HTTPError("API unavailable")

                result = await registry.get_server_by_id("nonexistent")
                assert result is None
        finally:
            await registry.close()


class TestMcpRegistryDedupe:
    """Test server deduplication."""

    def test_dedupe_keeps_latest_version(self):
        """Deduplication should keep the highest version."""
        servers = [
            McpRegistryServer(id="srv1", name="Server 1", version="1.0.0"),
            McpRegistryServer(id="srv1", name="Server 1", version="2.0.0"),
            McpRegistryServer(id="srv1", name="Server 1", version="1.5.0"),
        ]

        result = McpRegistry._dedupe_latest(servers)
        assert len(result) == 1
        assert result[0].version == "2.0.0"

    def test_dedupe_handles_no_version(self):
        """Deduplication should handle servers without version."""
        servers = [
            McpRegistryServer(id="srv1", name="Server 1", version=None),
            McpRegistryServer(id="srv2", name="Server 2", version="1.0.0"),
        ]

        result = McpRegistry._dedupe_latest(servers)
        assert len(result) == 2

    def test_dedupe_unique_ids(self):
        """Servers with unique IDs are all kept."""
        servers = [
            McpRegistryServer(id="srv1", name="Server 1", version="1.0.0"),
            McpRegistryServer(id="srv2", name="Server 2", version="1.0.0"),
            McpRegistryServer(id="srv3", name="Server 3", version="1.0.0"),
        ]

        result = McpRegistry._dedupe_latest(servers)
        assert len(result) == 3


class TestMcpRegistryV01Format:
    """Test v0.1 registry format parsing."""

    @pytest.mark.asyncio
    async def test_parse_v01_format(self, tmp_path: Path):
        """Parse official v0.1 registry format."""
        v01_data = {
            "servers": [
                {
                    "server": {
                        "name": "ai.example/test-server",
                        "description": "Test server",
                        "version": "1.0.0",
                        "packages": [
                            {
                                "registryType": "npm",
                                "identifier": "@example/test-server",
                            }
                        ],
                        "repository": {"url": "https://github.com/example/test"},
                    },
                    "_meta": {},
                }
            ]
        }

        seed_path = tmp_path / "v01_seed.json"
        seed_path.write_text(json.dumps(v01_data), encoding="utf-8")

        registry = McpRegistry(seed_path=seed_path)
        try:
            servers = await registry._load_from_seed()
            assert len(servers) == 1
            assert servers[0].name == "ai.example/test-server"
            assert servers[0].version == "1.0.0"
            assert len(servers[0].packages) == 1
            assert servers[0].packages[0].package_registry == "npm"
        finally:
            await registry.close()

    @pytest.mark.asyncio
    async def test_parse_legacy_format(self, temp_seed_file: Path):
        """Parse legacy Tepora format (already tested above)."""
        registry = McpRegistry(seed_path=temp_seed_file)
        try:
            servers = await registry._load_from_seed()
            assert len(servers) == 3
            # Legacy format uses registry field
            assert servers[0].packages[0].package_registry == "npm"
        finally:
            await registry.close()
