import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.tepora_server.app_factory import create_app


@pytest.fixture
def mock_core_app():
    with patch("src.tepora_server.state.TeporaCoreApp") as mock_class:
        mock_instance = mock_class.return_value

        async def async_init():
            return True

        mock_instance.initialize = MagicMock(side_effect=async_init)
        mock_instance.initialized = True
        yield mock_instance


@pytest.fixture
def client_with_auth(mock_core_app):
    # Set environment variable for API Key
    with patch.dict(os.environ, {"TEPORA_API_KEY": "test-secret", "TEPORA_ENV": "production"}):
        app = create_app()
        # Mock dependencies
        mock_state = MagicMock()
        mock_state.core = mock_core_app
        from src.tepora_server.api.dependencies import get_app_state

        app.dependency_overrides[get_app_state] = lambda: mock_state

        # We also need to mock valid return for requirements check so 200 is possible
        with patch("src.tepora_server.api.setup._get_download_manager") as mock_get_dm:
            mock_dm = MagicMock()

            async def mock_check():
                mock_status = MagicMock()
                return mock_status

            mock_dm.check_requirements = MagicMock(side_effect=mock_check)
            mock_get_dm.return_value = mock_dm

            with TestClient(app) as c:
                yield c


def test_setup_endpoints_with_auth(client_with_auth):
    """Test that /api/setup/* endpoints are accessible with proper authentication.

    Note: In production, session token authentication is required.
    This test verifies authenticated access to setup endpoints.
    """
    from src.tepora_server.api.security import get_api_key

    # Override authentication dependency
    client_with_auth.app.dependency_overrides[get_api_key] = lambda: "valid-key"
    try:
        response = client_with_auth.get("/api/setup/requirements")
        assert response.status_code == 200
    finally:
        client_with_auth.app.dependency_overrides.pop(get_api_key, None)


def test_setup_download_accessible_localhost(client_with_auth):
    """Test that POST /api/setup/binary/download is accessible without auth for localhost.

    Note: Authentication is intentionally skipped for localhost binding.
    """
    # Mock the download method to avoid actual download
    with patch("src.tepora_server.api.setup._get_download_manager") as mock_get_dm:
        mock_dm = MagicMock()

        async def mock_download(*args, **kwargs):
            return {"success": True}

        mock_dm.download_binary = MagicMock(side_effect=mock_download)
        mock_get_dm.return_value = mock_dm

        # Without auth header -> should still succeed for localhost
        response = client_with_auth.post("/api/setup/binary/download", json={"variant": "auto"})
        # Should not be 403 (auth passed)
        assert response.status_code != 403
