"""
Test Extension APIs: Config and Logs
"""

from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

import pytest
import yaml
from fastapi.testclient import TestClient

from src.tepora_server.api.security import get_api_key
from src.tepora_server.app_factory import create_app

# --- Fixtures ---


@pytest.fixture
def mock_core_app():
    """Mock the heavy TeporaCoreApp."""
    with patch("src.tepora_server.state.TeporaCoreApp") as mock_class:
        mock_instance = mock_class.return_value

        # Mock initialize as async
        async def async_init():
            return True

        mock_instance.initialize = MagicMock(side_effect=async_init)
        mock_instance.initialized = True
        yield mock_instance


@pytest.fixture
def client(mock_core_app):
    app = create_app()

    with TestClient(app) as c:
        # Inject mock core into the initialized app state
        c.app.state.app_state._core = mock_core_app
        yield c


@pytest.fixture
def run_with_auth(client):
    """Dependency override for successful authentication."""
    app = client.app
    app.dependency_overrides[get_api_key] = lambda: "valid-key"
    yield
    app.dependency_overrides = {}


# --- Config Tests ---


def test_get_config(client, run_with_auth):
    """Test retrieving configuration with defaults applied by Pydantic."""
    mock_config = {"app": {"language": "ja"}}  # Partial config

    mock_yaml = yaml.dump(mock_config)

    with (
        patch("builtins.open", mock_open(read_data=mock_yaml)),
        patch("pathlib.Path.exists", return_value=True),
    ):
        response = client.get("/api/config")

        assert response.status_code == 200
        resp_json = response.json()
        # Specified value should be preserved
        assert resp_json["app"]["language"] == "ja"
        # Default values should be applied
        assert "max_input_length" in resp_json["app"]
        assert isinstance(resp_json["app"]["max_input_length"], int)


def test_get_config_redacts_sensitive_info(client, run_with_auth):
    """Test that sensitive values are redacted in GET response."""
    # Use schema-valid sensitive fields
    mock_config = {
        "security": {"api_key": "super_secret_key_123"},
        "tools": {"google_search_api_key": "my_api_key"},
    }

    mock_yaml = yaml.dump(mock_config)

    with (
        patch("builtins.open", mock_open(read_data=mock_yaml)),
        patch("pathlib.Path.exists", return_value=True),
    ):
        response = client.get("/api/config")

        assert response.status_code == 200
        result = response.json()

        # Sensitive values should be masked
        assert result["security"]["api_key"] == "****"
        assert result["tools"]["google_search_api_key"] == "****"


def test_get_config_returns_defaults_when_no_file(client, run_with_auth):
    """Test that GET /api/config returns config with defaults when no config file exists."""
    with patch("src.core.config.service.ConfigService.load_config", return_value={}):
        response = client.get("/api/config")
        assert response.status_code == 200
        result = response.json()
        # Should have default structure from TeporaSettings
        assert "app" in result
        assert "characters" in result
        assert result["app"]["language"] == "en"  # Default language


def test_update_config(client, run_with_auth):
    """Test updating configuration."""
    new_config = {"app": {"name": "Updated Tepora"}}

    with (
        patch("builtins.open", mock_open()) as mocked_file,
        patch("pathlib.Path.exists", return_value=True),
    ):
        response = client.post("/api/config", json=new_config)

        assert response.status_code == 200
        assert response.json() == {"status": "success"}

        # Verify write
        mocked_file().write.assert_called()


def test_update_config_validates_with_pydantic(client, run_with_auth):
    """Test that invalid config is rejected by Pydantic validation."""
    # Invalid config with wrong type
    invalid_config = {
        "app": {
            "max_input_length": "not_a_number"  # Should be int
        }
    }

    with patch("pathlib.Path.exists", return_value=True):
        response = client.post("/api/config", json=invalid_config)

        assert response.status_code == 400
        result = response.json()
        assert "error" in result
        assert result["error"] == "Invalid configuration"
        assert "details" in result


def test_update_config_restores_redacted_values(client, run_with_auth):
    """Test that masked values '****' are restored from existing config."""
    # Existing config on disk
    existing_config = {
        "security": {"api_key": "original_secret_key"},
        "app": {"name": "Original Name"},
    }

    # Update request containing masked value
    update_request = {"security": {"api_key": "****"}, "app": {"name": "New Name"}}

    # Mock ConfigService methods to return existing config
    # and yaml.dump to capture what is written
    with (
        patch("src.core.config.service.ConfigService.load_config", return_value=existing_config),
        patch("src.core.config.service.ConfigService.save_config") as mock_save,
        patch("pathlib.Path.mkdir"),
    ):
        response = client.post("/api/config", json=update_request)
        assert response.status_code == 200

        # save_config should have been called once with the merged config
        assert mock_save.call_count == 1

        # Get the saved config from the call
        saved_config = mock_save.call_args[0][0]

        # api_key should be restored to original
        assert saved_config.get("security", {}).get("api_key") == "original_secret_key"
        # name should be updated
        assert saved_config.get("app", {}).get("name") == "New Name"


# --- Logs Tests ---


def test_get_logs_list(client, run_with_auth):
    """Test listing log files."""
    # Mock log directory and glob
    mock_log_file = MagicMock(spec=Path)
    mock_log_file.name = "server.log"
    mock_log_file.stat.return_value.st_mtime = 1000

    with patch("pathlib.Path.mkdir"), patch("pathlib.Path.glob", return_value=[mock_log_file]):
        response = client.get("/api/logs")

        assert response.status_code == 200
        assert response.json() == {"logs": ["server.log"]}


def test_get_logs_with_auth(client, run_with_auth):
    """Test that logs are accessible with proper authentication.

    Note: In production, session token authentication is required.
    This test verifies authenticated access to logs endpoint.
    """
    with patch("pathlib.Path.mkdir"), patch("pathlib.Path.glob", return_value=[]):
        response = client.get("/api/logs")
        # Should succeed with auth
        assert response.status_code == 200


def test_get_log_content(client, run_with_auth):
    """Test reading specific log file."""
    log_content = "INFO: Server started"

    mock_path = MagicMock(spec=Path)
    mock_path.exists.return_value = True
    mock_path.stat.return_value.st_size = len(log_content)

    with (
        patch("src.tepora_server.api.routes._get_log_dir"),
        patch("src.tepora_server.api.routes.SecurityUtils.safe_path_join", return_value=mock_path),
        patch("builtins.open", mock_open(read_data=log_content)),
    ):
        response = client.get("/api/logs/server.log")
        assert response.status_code == 200
        assert response.json() == {"content": log_content}


def test_log_traversal_attack(client, run_with_auth):
    """Test directory traversal attempt."""
    # The actual traversal check happens inside SecurityUtils.safe_path_join.
    # We mock it to raise ValueError regardless of the filename,
    # simulating a traversal detection.
    with (
        patch("src.tepora_server.api.routes._get_log_dir"),
        patch(
            "src.tepora_server.api.routes.SecurityUtils.safe_path_join",
            side_effect=ValueError("Path traversal detected"),
        ),
    ):
        response = client.get("/api/logs/suspicious.log")
        assert response.status_code == 403, (
            f"Expected 403 but got {response.status_code}. Body: {response.text}"
        )
        assert "Invalid filename" in response.json()["error"]
