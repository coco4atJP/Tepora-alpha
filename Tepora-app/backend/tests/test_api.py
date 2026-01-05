from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Import factory
from src.tepora_server.app_factory import create_app


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

        # Mock memory stats for status endpoint
        mock_instance.get_memory_stats.return_value = {
            "char_memory": {"total_events": 10},
            "prof_memory": {"total_events": 5},
        }
        mock_instance.history_manager.get_message_count.return_value = 100

        yield mock_instance


@pytest.fixture
def client(mock_core_app):
    """Create a TestClient with a mocked core."""
    app = create_app()

    # Create a mock AppState that returns our mock_core_app
    mock_state = MagicMock()
    mock_state.core = mock_core_app

    # Override the dependency
    from src.tepora_server.api.dependencies import get_app_state

    app.dependency_overrides[get_app_state] = lambda: mock_state

    with TestClient(app) as c:
        yield c


def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "initialized" in data
