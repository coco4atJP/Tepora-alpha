"""
WebSocket Security Tests

Tests for Origin validation and token authentication on WebSocket connections.
"""

from unittest.mock import MagicMock, patch

from fastapi import WebSocket

from src.tepora_server.api.ws import WS_ALLOWED_ORIGINS, _validate_origin, _validate_token


class TestOriginValidation:
    """Tests for WebSocket Origin validation."""

    @patch.dict("os.environ", {"TEPORA_ENV": "development"})
    def test_no_origin_allowed_in_development(self):
        """Connections without Origin header are allowed in development."""
        assert _validate_origin(None) is True

    @patch.dict("os.environ", {"TEPORA_ENV": "production"})
    def test_no_origin_rejected_in_production(self):
        """Connections without Origin header are rejected in production."""
        assert _validate_origin(None) is False

    def test_tauri_origin_allowed(self):
        """Tauri desktop app origin should be allowed."""
        assert _validate_origin("tauri://localhost") is True
        assert _validate_origin("https://tauri.localhost") is True

    def test_localhost_origins_allowed(self):
        """Various localhost origins should be allowed."""
        assert _validate_origin("http://localhost:5173") is True
        assert _validate_origin("http://localhost:3000") is True
        assert _validate_origin("http://localhost:8000") is True
        assert _validate_origin("http://127.0.0.1:5173") is True

    def test_external_origin_rejected(self):
        """External origins should be rejected."""
        assert _validate_origin("http://malicious-site.com") is False
        assert _validate_origin("https://external.example.com") is False
        assert _validate_origin("http://192.168.1.100:8000") is False

    def test_partial_match_rejected(self):
        """Partial matches should not be allowed if not in prefix list."""
        # The origin must be exactly or start with an allowed origin
        assert _validate_origin("http://localhost.malicious.com") is False


class TestTokenValidation:
    """Tests for WebSocket token validation."""

    @patch("src.tepora_server.api.ws.get_session_token")
    @patch.dict("os.environ", {"TEPORA_ENV": "development"})
    def test_development_mode_requires_token_when_initialized(self, mock_get_token):
        """Development mode must not bypass token validation when initialized."""
        mock_get_token.return_value = "valid_secret_token"
        mock_ws = MagicMock(spec=WebSocket)
        mock_ws.query_params = {"token": "wrong_token"}

        assert _validate_token(mock_ws) is False

    @patch("src.tepora_server.api.ws.get_session_token")
    @patch.dict("os.environ", {"TEPORA_ENV": "production"})
    def test_production_mode_no_token_rejected(self, mock_get_token):
        """In production without token, connection should be rejected when token is required."""
        mock_get_token.return_value = "valid_secret_token"  # Server has a token
        mock_ws = MagicMock(spec=WebSocket)
        mock_ws.query_params = {}

        assert _validate_token(mock_ws) is False

    @patch("src.tepora_server.api.ws.get_session_token")
    @patch.dict("os.environ", {"TEPORA_ENV": "production"})
    def test_production_mode_no_token_allowed_before_init(self, mock_get_token):
        """Before server initialization (token is None), allow connections."""
        mock_get_token.return_value = None  # Server not initialized yet
        mock_ws = MagicMock(spec=WebSocket)
        mock_ws.query_params = {}

        assert _validate_token(mock_ws) is True

    @patch("src.tepora_server.api.ws.get_session_token")
    @patch.dict("os.environ", {"TEPORA_ENV": "production"})
    def test_valid_token_accepted(self, mock_get_token):
        """Valid token should be accepted."""
        mock_get_token.return_value = "valid_secret_token"
        mock_ws = MagicMock(spec=WebSocket)
        mock_ws.query_params = {"token": "valid_secret_token"}

        assert _validate_token(mock_ws) is True

    @patch("src.tepora_server.api.ws.get_session_token")
    @patch.dict("os.environ", {"TEPORA_ENV": "production"})
    def test_invalid_token_rejected(self, mock_get_token):
        """Invalid token should be rejected."""
        mock_get_token.return_value = "valid_secret_token"
        mock_ws = MagicMock(spec=WebSocket)
        mock_ws.query_params = {"token": "invalid_token"}

        assert _validate_token(mock_ws) is False


class TestAllowedOriginsList:
    """Tests for the allowed origins configuration."""

    def test_tauri_origins_in_list(self):
        """Tauri-related origins should be in allowed list."""
        assert "tauri://localhost" in WS_ALLOWED_ORIGINS
        assert "https://tauri.localhost" in WS_ALLOWED_ORIGINS

    def test_development_origins_in_list(self):
        """Development server origins should be in allowed list."""
        assert "http://localhost:5173" in WS_ALLOWED_ORIGINS
        assert "http://localhost:3000" in WS_ALLOWED_ORIGINS
