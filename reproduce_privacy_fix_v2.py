
import sys
import os
import unittest
from unittest.mock import MagicMock, patch

# Add src to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "Tepora-app/backend/src")))
os.environ["TEPORA_ROOT"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "Tepora-app/backend"))

class TestPrivacyFixV2(unittest.IsolatedAsyncioTestCase):
    
    @patch("src.core.tools.native.settings")
    async def test_1_tool_registration_disabled(self, mock_settings):
        # Configure allow_web_search to be specifically False (bool)
        # Using type(mock.p.a) = bool doesn't work, we set attribute
        mock_settings.privacy.allow_web_search = False
        # Also ensure boolean evaluation of the property itself is False if it was checking property existence (it's not)
        
        from src.core.tools.native import NativeToolProvider
        provider = NativeToolProvider()
        tools = await provider.load_tools()
        
        tool_names = [t.name for t in tools]
        print(f"\n[Test 1 Disabled] Tools: {tool_names}")
        self.assertNotIn("native_web_fetch", tool_names)

    @patch("src.core.tools.native.settings")
    async def test_2_tool_registration_enabled(self, mock_settings):
        mock_settings.privacy.allow_web_search = True
        mock_settings.tools.google_search_api_key = None
        
        from src.core.tools.native import NativeToolProvider
        provider = NativeToolProvider()
        tools = await provider.load_tools()
        
        tool_names = [t.name for t in tools]
        print(f"\n[Test 2 Enabled] Tools: {tool_names}")
        self.assertIn("native_web_fetch", tool_names)

    @patch("src.core.tools.native.settings")
    def test_3_url_validation_denylist(self, mock_settings):
        mock_settings.privacy.url_denylist = ["localhost", "127.0.0.1"]
        
        from src.core.tools.native import WebFetchTool
        tool = WebFetchTool()
        
        error = tool._validate_url("http://localhost/foo")
        print(f"\n[Test 3 Denylist] localhost error: {error}")
        self.assertIsNotNone(error)
        self.assertIn("blocked", error)
        
        error = tool._validate_url("http://google.com")
        self.assertIsNone(error)

    @patch("src.core.tools.native.settings")
    def test_4_url_validation_dns(self, mock_settings):
        mock_settings.privacy.url_denylist = []
        
        from src.core.tools.native import WebFetchTool
        tool = WebFetchTool()
        
        # Patch socket.getaddrinfo GLOBAL in native module used namespace
        # native.py imports socket. So we patch socket.getaddrinfo
        with patch("socket.getaddrinfo") as mock_dns:
            # Case A: Private IP
            mock_dns.return_value = [(2, 1, 6, '', ('127.0.0.1', 80))]
            error = tool._validate_url("http://localtest.me/foo")
            print(f"\n[Test 4 DNS] Private IP error: {error}")
            self.assertIsNotNone(error)
            self.assertIn("private/local IP", error)
            
            # Case B: Public IP
            mock_dns.return_value = [(2, 1, 6, '', ('8.8.8.8', 80))]
            error = tool._validate_url("http://google.com")
            print(f"[Test 4 DNS] Public IP error: {error}")
            self.assertIsNone(error)

if __name__ == "__main__":
    unittest.main()
