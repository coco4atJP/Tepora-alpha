import unittest
from unittest.mock import MagicMock, patch, AsyncMock, ANY
import sys
from pathlib import Path
import asyncio

# Add backend/src to sys.path
sys.path.append(str(Path(__file__).resolve().parents[1] / "src"))

from src.core.tool_manager import ToolManager
from src.core.tools.base import ToolProvider


class MockToolProvider(ToolProvider):
    """Mock ToolProvider for testing."""
    
    def __init__(self, tools=None):
        self._tools = tools or []
    
    async def load_tools(self):
        return self._tools
    
    def cleanup(self):
        pass


class TestToolManager(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        pass
        
    @patch("src.core.tool_manager.config.filter_tools_for_profile")
    @patch("src.core.tool_manager.config.get_active_agent_profile_name", return_value="default")
    def test_initialize(self, mock_profile, mock_filter):
        # Setup mocks
        mock_native_tool = MagicMock()
        mock_native_tool.name = "native_tool"
        
        mock_mcp_tool = MagicMock()
        mock_mcp_tool.name = "mcp_tool"
        
        # Mock filter to return all tools
        mock_filter.side_effect = lambda tools, profile: tools
        
        # Create mock providers
        native_provider = MockToolProvider([mock_native_tool])
        mcp_provider = MockToolProvider([mock_mcp_tool])
        
        # Initialize with providers
        manager = ToolManager(providers=[native_provider, mcp_provider])
        manager.initialize()
        
        # Verify
        self.assertEqual(len(manager.tools), 2)
        self.assertIn("native_tool", manager.tool_map)
        self.assertIn("mcp_tool", manager.tool_map)
        
        # Cleanup
        manager.cleanup()

    @patch("src.core.tool_manager.config.filter_tools_for_profile")
    @patch("src.core.tool_manager.config.get_active_agent_profile_name", return_value="default")
    def test_get_tool(self, mock_profile, mock_filter):
        mock_tool = MagicMock()
        mock_tool.name = "test_tool"
        mock_filter.side_effect = lambda tools, profile: tools
        
        provider = MockToolProvider([mock_tool])
        manager = ToolManager(providers=[provider])
        manager.initialize()
        
        tool = manager.get_tool("test_tool")
        self.assertEqual(tool, mock_tool)
        
        tool = manager.get_tool("non_existent")
        self.assertIsNone(tool)
        
        manager.cleanup()

    @patch("src.core.tool_manager.config.filter_tools_for_profile")
    @patch("src.core.tool_manager.config.get_active_agent_profile_name", return_value="default")
    def test_execute_tool(self, mock_profile, mock_filter):
        # Test the sync bridge
        mock_filter.side_effect = lambda tools, profile: tools
        
        manager = ToolManager(providers=[])
        
        # Mock aexecute_tool to isolate the bridge logic
        manager.aexecute_tool = AsyncMock(return_value="success")
        
        result = manager.execute_tool("test_tool", {"arg": "value"})
        self.assertEqual(result, "success")
        manager.aexecute_tool.assert_called_with("test_tool", {"arg": "value"})
        
        manager.cleanup()

    @patch("src.core.tool_manager.config.filter_tools_for_profile")
    @patch("src.core.tool_manager.config.get_active_agent_profile_name", return_value="default")
    async def test_aexecute_tool(self, mock_profile, mock_filter):
        # Test async execution
        mock_tool = MagicMock()
        mock_tool.name = "async_tool"
        mock_tool.ainvoke = AsyncMock(return_value="async_success")
        mock_filter.side_effect = lambda tools, profile: tools
        
        provider = MockToolProvider([mock_tool])
        manager = ToolManager(providers=[provider])
        manager.initialize()
        
        result = await manager.aexecute_tool("async_tool", {"arg": "value"})
        self.assertEqual(result, "async_success")
        mock_tool.ainvoke.assert_called_with({"arg": "value"})
        
        manager.cleanup()


if __name__ == "__main__":
    unittest.main()
