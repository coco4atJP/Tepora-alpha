
import sys
import os
import unittest
from unittest.mock import MagicMock, patch

# Add src to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "Tepora-app/backend/src")))

# Mock environment if needed
os.environ["TEPORA_ROOT"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "Tepora-app/backend"))

# Mock settings before importing modules that use them
with patch("src.core.config.loader.settings") as mock_settings:
    # Setup default mock values
    mock_settings.privacy.allow_web_search = False
    mock_settings.privacy.url_denylist = ["localhost", "127.0.0.1", "10.*"]
    mock_settings.tools.google_search_api_key = None
    
    # Import relevant modules
    from src.core.tools.native import NativeToolProvider, WebFetchTool
    
class TestPrivacyFix(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Reset mock settings provided by patch in actual test methods if needed
        # But since we patched at module level, we might need to repatch or configure the mock
        pass

    @patch("src.core.tools.native.settings")
    async def test_tool_registration_disabled(self, mock_settings):
        """Test that WebFetchTool is NOT registered when allow_web_search is False."""
        mock_settings.privacy.allow_web_search = False
        mock_settings.privacy.url_denylist = []
        mock_settings.tools.google_search_api_key = None
        
        provider = NativeToolProvider()
        tools = await provider.load_tools()
        
        tool_names = [t.name for t in tools]
        print(f"Tools loaded (disabled): {tool_names}")
        self.assertNotIn("native_web_fetch", tool_names)

    @patch("src.core.tools.native.settings")
    async def test_tool_registration_enabled(self, mock_settings):
        """Test that WebFetchTool IS registered when allow_web_search is True."""
        mock_settings.privacy.allow_web_search = True
        mock_settings.privacy.url_denylist = []
        mock_settings.tools.google_search_api_key = None # ensure google search doesn't crash
        
        provider = NativeToolProvider()
        tools = await provider.load_tools()
        
        tool_names = [t.name for t in tools]
        print(f"Tools loaded (enabled): {tool_names}")
        self.assertIn("native_web_fetch", tool_names)

    @patch("src.core.tools.native.settings")
    def test_url_validation_denylist(self, mock_settings):
        """Test URL validation against denylist."""
        mock_settings.privacy.url_denylist = ["localhost", "127.0.0.1", "*.internal"]
        
        tool = WebFetchTool()
        
        # Localhost should be blocked by denylist
        error = tool._validate_url("http://localhost/foo")
        self.assertIsNotNone(error)
        self.assertIn("blocked", error)
        print(f"Localhost check: {error}")

        # 127.0.0.1 should be blocked by denylist
        error = tool._validate_url("http://127.0.0.1/foo")
        self.assertIsNotNone(error)
        print(f"IP check: {error}")

    @patch("src.core.tools.native.settings")
    def test_url_validation_dns_resolution(self, mock_settings):
        """Test URL validation with DNS resolution (private IP blocking)."""
        mock_settings.privacy.url_denylist = []
        
        tool = WebFetchTool()
        
        # Mock socket.getaddrinfo to simulate private IP resolution
        with patch("socket.getaddrinfo") as mock_getaddrinfo:
            # Simulate 'localtest.me' resolving to 127.0.0.1
            mock_getaddrinfo.return_value = [
                (2, 1, 6, '', ('127.0.0.1', 80))
            ]
            
            error = tool._validate_url("http://localtest.me/foo")
            self.assertIsNotNone(error)
            self.assertIn("private_ip", error)
            print(f"DNS Resolution check (private): {error}")
            
            # Simulate public IP
            mock_getaddrinfo.return_value = [
                (2, 1, 6, '', ('8.8.8.8', 80))
            ]
            error = tool._validate_url("http://google.com")
            self.assertIsNone(error)
            print("DNS Resolution check (public): Passed")

if __name__ == "__main__":
    unittest.main()
