"""
Tests for MCP Store API Routes.

Tests:
- GET /api/mcp/store - List servers from registry
- Pagination, search filtering, runtime filtering
- Error handling
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.core.mcp.models import EnvVarSchema, McpRegistryServer, PackageInfo
from src.tepora_server.api.mcp_routes import router


@pytest.fixture
def mock_app_state():
    """Create a mock AppState."""
    state = MagicMock()
    state.mcp_registry = MagicMock()
    state.mcp_hub = MagicMock()
    return state


@pytest.fixture
def sample_servers() -> list[McpRegistryServer]:
    """Sample MCP servers for testing."""
    return [
        McpRegistryServer(
            id="filesystem",
            name="@modelcontextprotocol/server-filesystem",
            title="Filesystem Server",
            description="Secure file operations",
            version="1.0.0",
            vendor="Anthropic",
            packages=[
                PackageInfo(
                    name="@modelcontextprotocol/server-filesystem",
                    registry="npm",
                    runtimeHint="npx",
                )
            ],
            environmentVariables=[],
        ),
        McpRegistryServer(
            id="fetch",
            name="@modelcontextprotocol/server-fetch",
            title="Fetch Server",
            description="Web content fetching",
            version="1.0.0",
            vendor="Anthropic",
            packages=[
                PackageInfo(
                    name="@modelcontextprotocol/server-fetch",
                    registry="npm",
                    runtimeHint="npx",
                )
            ],
            environmentVariables=[],
        ),
        McpRegistryServer(
            id="github",
            name="@modelcontextprotocol/server-github",
            title="GitHub Server",
            description="GitHub API integration",
            version="1.0.0",
            vendor="Anthropic",
            packages=[
                PackageInfo(
                    name="@modelcontextprotocol/server-github",
                    registry="npm",
                    runtimeHint="npx",
                )
            ],
            environmentVariables=[
                EnvVarSchema(
                    name="GITHUB_PERSONAL_ACCESS_TOKEN",
                    description="GitHub Personal Access Token",
                    isRequired=True,
                    isSecret=True,
                )
            ],
        ),
        McpRegistryServer(
            id="python-server",
            name="python-mcp-server",
            title="Python Server",
            description="Python-based MCP server",
            version="0.1.0",
            packages=[
                PackageInfo(
                    name="python-mcp-server",
                    registry="pypi",
                    runtimeHint="uvx",
                )
            ],
            environmentVariables=[],
        ),
    ]


@pytest.fixture
def app(mock_app_state):
    """Create a FastAPI app with the MCP routes."""
    app = FastAPI()

    # Override the dependency
    from src.tepora_server.api.dependencies import get_app_state

    app.dependency_overrides[get_app_state] = lambda: mock_app_state

    # Override security for testing
    from src.tepora_server.api.security import get_api_key

    app.dependency_overrides[get_api_key] = lambda: None

    app.include_router(router)
    return app


@pytest.fixture
def client(app):
    """Create a test client."""
    return TestClient(app)


class TestGetMcpStore:
    """Test GET /api/mcp/store endpoint."""

    def test_get_store_success(self, client: TestClient, mock_app_state, sample_servers):
        """Fetch store returns servers successfully."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=sample_servers)

        response = client.get("/api/mcp/store")
        assert response.status_code == 200

        data = response.json()
        assert "servers" in data
        assert "total" in data
        assert "page" in data
        assert "page_size" in data
        assert "has_more" in data

        assert data["total"] == 4
        assert data["page"] == 1
        assert len(data["servers"]) == 4

    def test_get_store_pagination(self, client: TestClient, mock_app_state, sample_servers):
        """Verify pagination works correctly."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=sample_servers)

        # Get page 1 with page_size=2
        response = client.get("/api/mcp/store", params={"page": 1, "page_size": 2})
        assert response.status_code == 200

        data = response.json()
        assert data["total"] == 4
        assert data["page"] == 1
        assert data["page_size"] == 2
        assert data["has_more"] is True
        assert len(data["servers"]) == 2

    def test_get_store_pagination_page_2(self, client: TestClient, mock_app_state, sample_servers):
        """Verify page 2 returns correct data."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=sample_servers)

        response = client.get("/api/mcp/store", params={"page": 2, "page_size": 2})
        assert response.status_code == 200

        data = response.json()
        assert data["page"] == 2
        assert len(data["servers"]) == 2
        assert data["has_more"] is False

    def test_get_store_search_filter(self, client: TestClient, mock_app_state, sample_servers):
        """Verify search parameter is passed to registry."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=[sample_servers[2]])

        response = client.get("/api/mcp/store", params={"search": "github"})
        assert response.status_code == 200

        # Verify fetch_servers was called with search parameter
        mock_app_state.mcp_registry.fetch_servers.assert_called_once()
        call_kwargs = mock_app_state.mcp_registry.fetch_servers.call_args[1]
        assert call_kwargs.get("search") == "github"

    def test_get_store_runtime_filter(self, client: TestClient, mock_app_state, sample_servers):
        """Verify runtime filter works correctly."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=sample_servers)

        response = client.get("/api/mcp/store", params={"runtime": "uvx"})
        assert response.status_code == 200

        data = response.json()
        # Only python-server has uvx runtime
        assert data["total"] == 1
        assert data["servers"][0]["id"] == "python-server"

    def test_get_store_refresh_cache(self, client: TestClient, mock_app_state, sample_servers):
        """Verify refresh parameter forces cache refresh."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=sample_servers)

        response = client.get("/api/mcp/store", params={"refresh": True})
        assert response.status_code == 200

        call_kwargs = mock_app_state.mcp_registry.fetch_servers.call_args[1]
        assert call_kwargs.get("force_refresh") is True

    def test_get_store_no_registry(self, client: TestClient, mock_app_state):
        """Return empty list when registry not initialized."""
        mock_app_state.mcp_registry = None

        response = client.get("/api/mcp/store")
        assert response.status_code == 200

        data = response.json()
        assert data["servers"] == []
        assert data["total"] == 0

    def test_get_store_error_handling(self, client: TestClient, mock_app_state):
        """Handle errors gracefully."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(
            side_effect=Exception("Network error")
        )

        response = client.get("/api/mcp/store")
        assert response.status_code == 500

    def test_get_store_page_size_clamped(self, client: TestClient, mock_app_state, sample_servers):
        """Page size is clamped to maximum 200."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=sample_servers)

        response = client.get("/api/mcp/store", params={"page_size": 500})
        assert response.status_code == 200

        data = response.json()
        assert data["page_size"] == 200

    def test_get_store_invalid_page_clamped(
        self, client: TestClient, mock_app_state, sample_servers
    ):
        """Invalid page number is clamped to 1."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=sample_servers)

        response = client.get("/api/mcp/store", params={"page": -1})
        assert response.status_code == 200

        data = response.json()
        assert data["page"] == 1

    def test_get_store_server_serialization(
        self, client: TestClient, mock_app_state, sample_servers
    ):
        """Verify server data is serialized correctly."""
        mock_app_state.mcp_registry.fetch_servers = AsyncMock(return_value=[sample_servers[2]])

        response = client.get("/api/mcp/store")
        assert response.status_code == 200

        data = response.json()
        server = data["servers"][0]

        assert server["id"] == "github"
        assert server["name"] == "@modelcontextprotocol/server-github"
        assert server["title"] == "GitHub Server"
        assert server["description"] == "GitHub API integration"
        assert server["version"] == "1.0.0"
        assert server["vendor"] == "Anthropic"

        # Check packages
        assert len(server["packages"]) == 1
        pkg = server["packages"][0]
        assert pkg["name"] == "@modelcontextprotocol/server-github"
        assert pkg["runtimeHint"] == "npx"
        assert pkg["registry"] == "npm"

        # Check environment variables
        assert len(server["environmentVariables"]) == 1
        env = server["environmentVariables"][0]
        assert env["name"] == "GITHUB_PERSONAL_ACCESS_TOKEN"
        assert env["isRequired"] is True
        assert env["isSecret"] is True


class TestInstallPreview:
    """Test POST /api/mcp/install/preview endpoint."""

    def test_preview_install_success(self, client: TestClient, mock_app_state, sample_servers):
        """Preview install returns consent payload."""
        mock_app_state.mcp_registry.get_server_by_id = AsyncMock(return_value=sample_servers[0])

        with patch("src.tepora_server.api.mcp_routes.McpInstaller") as mock_installer:
            mock_installer.generate_consent_payload.return_value = {
                "server_id": "filesystem",
                "server_name": "Filesystem Server",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem"],
                "env": {},
                "full_command": "npx -y @modelcontextprotocol/server-filesystem",
                "warnings": [],
                "requires_consent": True,
            }

            response = client.post(
                "/api/mcp/install/preview",
                json={"server_id": "filesystem"},
            )

            assert response.status_code == 200
            data = response.json()
            assert "consent_id" in data
            assert "expires_in_seconds" in data
            assert data["server_id"] == "filesystem"

    def test_preview_install_not_found(self, client: TestClient, mock_app_state):
        """Preview install returns 404 for unknown server."""
        mock_app_state.mcp_registry.get_server_by_id = AsyncMock(return_value=None)

        response = client.post(
            "/api/mcp/install/preview",
            json={"server_id": "nonexistent"},
        )

        assert response.status_code == 404


class TestInstallConfirm:
    """Test POST /api/mcp/install/confirm endpoint."""

    def test_confirm_install_invalid_consent(self, client: TestClient):
        """Confirm install fails with invalid consent ID."""
        response = client.post(
            "/api/mcp/install/confirm",
            json={"consent_id": "invalid-id"},
        )

        assert response.status_code == 400
        assert "Invalid or expired consent ID" in response.json()["detail"]
