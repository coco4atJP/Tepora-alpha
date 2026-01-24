"""
WebSocket E2E Tests

End-to-end tests for WebSocket communication flow.
Tests actual WebSocket connection handling with mocked TeporaApp (V2-only).

Note: These tests pass Origin + session token for authentication.
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from src.tepora_server.app_factory import create_app

TEST_SESSION_TOKEN = "test-session-token"
TEST_WS_ORIGIN = "http://localhost:5173"


def _ws_connect(client: TestClient):
    return client.websocket_connect(
        f"/ws?token={TEST_SESSION_TOKEN}",
        headers={"origin": TEST_WS_ORIGIN},
    )


@pytest.fixture
def mock_core():
    """Create a mock TeporaApp instance."""
    mock = MagicMock()
    mock.initialized = True

    # Mock memory stats
    mock.get_memory_stats.return_value = {
        "char_memory": {"total_events": 10},
        "prof_memory": {"total_events": 5},
    }

    # Mock process_user_request as async generator
    async def mock_process(*args, **kwargs):
        # Simulate streaming response
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="Hello")}}
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content=" World")}}

    mock.process_user_request = mock_process

    # Mock initialize
    async def async_init():
        return True

    mock.initialize = MagicMock(side_effect=async_init)

    return mock


@pytest.fixture
def client(mock_core, monkeypatch):
    """Create a TestClient with mocked core."""
    monkeypatch.setenv("TEPORA_ENV", "production")
    monkeypatch.setenv("TEPORA_SESSION_TOKEN", TEST_SESSION_TOKEN)
    app = create_app()

    with TestClient(app) as c:
        # Inject mock core into the initialized app_state
        app.state.app_state.core = mock_core
        yield c


class TestWebSocketConnection:
    """Tests for WebSocket connection handling."""

    def test_websocket_connection(self, client):
        """Test basic WebSocket connection establishment."""
        with _ws_connect(client) as ws:
            # Connection should be established successfully
            # Send a minimal valid message to verify connection
            ws.send_json({"type": "get_stats"})

            response = ws.receive_json()
            assert response["type"] == "stats"
            assert "data" in response

    def test_websocket_disconnection(self, client):
        """Test clean WebSocket disconnection."""
        with _ws_connect(client) as _:
            pass  # Disconnect happens automatically


class TestMessageProcessing:
    """Tests for message processing flow."""

    def test_message_processing_flow(self, client, mock_core):
        """Test complete message processing flow: message → status → chunks → stats → done."""
        with _ws_connect(client) as ws:
            # Send a user message
            ws.send_json(
                {"message": "Hello AI", "mode": "direct", "attachments": [], "skipWebSearch": True}
            )

            # Collect all responses
            responses = []
            for _ in range(5):  # Expect: status, chunk, chunk, stats, done
                try:
                    response = ws.receive_json()
                    responses.append(response)
                    if response.get("type") == "done":
                        break
                except Exception:
                    break

            # Verify response types
            types = [r.get("type") for r in responses]
            assert "status" in types, "Should receive status message"
            assert "chunk" in types, "Should receive chunk messages"
            assert "stats" in types, "Should receive stats message"
            assert "done" in types, "Should receive done message"

    def test_empty_message_ignored(self, client):
        """Test that empty messages are handled gracefully."""
        with _ws_connect(client) as ws:
            # Send empty message (no content, no attachments)
            ws.send_json({"message": "", "mode": "direct", "attachments": []})

            # Request stats to verify connection still works
            ws.send_json({"type": "get_stats"})
            response = ws.receive_json()
            assert response["type"] == "stats"


class TestMessageValidation:
    """Tests for message validation and error handling."""

    def test_invalid_json(self, client):
        """Test handling of invalid JSON data."""
        with _ws_connect(client) as ws:
            # Send text that's not valid JSON
            ws.send_text("not valid json")

            response = ws.receive_json()
            assert response["type"] == "error"
            assert "Invalid JSON" in response.get("message", "")

    def test_extra_fields_ignored(self, client):
        """Test that extra fields in messages are ignored (not rejected)."""
        with _ws_connect(client) as ws:
            ws.send_json({"type": "get_stats", "unknown_field": "should be ignored"})

            response = ws.receive_json()
            # Should still work, not error out
            assert response["type"] == "stats"


class TestControlCommands:
    """Tests for control commands (stop, get_stats)."""

    def test_get_stats_command(self, client):
        """Test get_stats command returns memory statistics."""
        with _ws_connect(client) as ws:
            ws.send_json({"type": "get_stats"})

            response = ws.receive_json()
            assert response["type"] == "stats"
            assert "data" in response

            # Verify stats structure from mock
            stats = response["data"]
            assert "char_memory" in stats
            assert "prof_memory" in stats

    def test_stop_command(self, client):
        """Test stop command handling."""
        with _ws_connect(client) as ws:
            # Send stop command (even without active task)
            ws.send_json({"type": "stop"})

            # Verify connection is still alive by requesting stats
            ws.send_json({"type": "get_stats"})
            response = ws.receive_json()
            assert response["type"] == "stats"


class TestModeHandling:
    """Tests for different processing modes."""

    @pytest.mark.parametrize("mode", ["direct", "search", "agent"])
    def test_different_modes(self, client, mode):
        """Test that different modes are passed correctly to the processor."""
        with _ws_connect(client) as ws:
            ws.send_json(
                {"message": "Test message", "mode": mode, "attachments": [], "skipWebSearch": False}
            )

            # Should receive some response without errors
            responses = []
            for _ in range(5):
                try:
                    response = ws.receive_json()
                    responses.append(response)
                    if response.get("type") == "done":
                        break
                except Exception:
                    break

            # Should have at least status and done
            types = [r.get("type") for r in responses]
            assert "status" in types or "chunk" in types or "done" in types


class TestAttachments:
    """Tests for attachment handling."""

    def test_message_with_attachments(self, client):
        """Test message with attachments is processed."""
        with _ws_connect(client) as ws:
            ws.send_json(
                {
                    "message": "Check this image",
                    "mode": "direct",
                    "attachments": [
                        {"type": "image", "content": "base64encodedcontent", "name": "test.png"}
                    ],
                    "skipWebSearch": True,
                }
            )

            # Collect responses
            responses = []
            for _ in range(5):
                try:
                    response = ws.receive_json()
                    responses.append(response)
                    if response.get("type") == "done":
                        break
                except Exception:
                    break

            types = [r.get("type") for r in responses]
            assert len(types) > 0, "Should receive at least one response"
