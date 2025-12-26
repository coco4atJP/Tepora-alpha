"""
WebSocket Security Tests

Tests for Origin validation and token authentication on WebSocket connections.
"""
import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from fastapi import WebSocket

from src.tepora_server.api.ws import _validate_origin, _validate_token, WS_ALLOWED_ORIGINS


class TestOriginValidation:
    """Tests for WebSocket Origin validation."""
    
    def test_no_origin_allowed(self):
        """Connections without Origin header should be allowed (same-origin)."""
        assert _validate_origin(None) is True
    
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
    
    @patch.dict("os.environ", {"TEPORA_ENV": "development"})
    def test_development_mode_skips_validation(self):
        """In development mode, token validation should be skipped."""
        mock_ws = MagicMock(spec=WebSocket)
        mock_ws.query_params = {"token": "wrong_token"}
        
        assert _validate_token(mock_ws) is True
    
    @patch.dict("os.environ", {"TEPORA_ENV": "production"})
    def test_production_mode_no_token_allowed(self):
        """In production without token, allow for backwards compatibility."""
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
