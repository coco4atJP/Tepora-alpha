
from unittest.mock import patch

import pytest

from src.core.tools.native import NativeToolProvider, WebFetchTool

@pytest.mark.asyncio
async def test_native_tool_provider_respects_privacy():
    """Test that WebFetchTool is only registered when privacy.allow_web_search is True."""

    # Case 1: Privacy blocked
    with patch("src.core.tools.native.settings") as mock_settings:
        mock_settings.privacy.allow_web_search = False
        mock_settings.tools.google_search_api_key = None
    
        provider = NativeToolProvider()
        tools = await provider.load_tools()
    
        tool_names = [t.name for t in tools]
        assert "native_web_fetch" not in tool_names

    # Case 2: Privacy allowed
    with patch("src.core.tools.native.settings") as mock_settings:
        mock_settings.privacy.allow_web_search = True
        mock_settings.tools.google_search_api_key = None
    
        provider = NativeToolProvider()
        tools = await provider.load_tools()
    
        tool_names = [t.name for t in tools]
        assert "native_web_fetch" in tool_names

def test_web_fetch_url_validation_denylist():
    """Test URL validation against denylist."""
    with patch("src.core.tools.native.settings") as mock_settings:
        mock_settings.privacy.url_denylist = ["localhost", "127.0.0.1"]
    
        tool = WebFetchTool()
    
        # Should be blocked
        assert tool._validate_url("http://localhost/foo") is not None
        assert tool._validate_url("http://127.0.0.1/bar") is not None
    
        # Should pass
        assert tool._validate_url("http://google.com") is None

def test_web_fetch_url_validation_dns_ssrf():
    """Test URL validation with DNS resolution for SSRF protection."""
    with patch("src.core.tools.native.settings") as mock_settings:
        mock_settings.privacy.url_denylist = []
    
        tool = WebFetchTool()
    
        with patch("socket.getaddrinfo") as mock_dns:
            # Simulate private IP resolution
            mock_dns.return_value = [(2, 1, 6, '', ('127.0.0.1', 80))]
            error = tool._validate_url("http://localtest.me")
            assert error is not None
            assert "blocked" in error or "private" in error
            
            # Simulate public IP resolution
            mock_dns.return_value = [(2, 1, 6, '', ('8.8.8.8', 80))]
            error = tool._validate_url("http://real-site.com")
            assert error is None
