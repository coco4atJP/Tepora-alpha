import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# Add backend/src to sys.path
sys.path.append(str(Path(__file__).resolve().parents[1] / "src"))

from src.core.tools.base import ToolProvider
from src.core.tools.manager import ToolManager


class MockToolProvider(ToolProvider):
    """Mock ToolProvider for testing."""

    def __init__(self, tools=None):
        self._tools = tools or []

    @property
    def name(self) -> str:
        """Return provider name."""
        return "mock"

    async def load_tools(self):
        return self._tools

    def cleanup(self):
        pass


class TestToolManager(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        pass

    def test_initialize(self):
        # Setup mocks
        mock_native_tool = MagicMock()
        mock_native_tool.name = "native_tool"

        mock_mcp_tool = MagicMock()
        mock_mcp_tool.name = "mcp_tool"

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

    def test_get_tool(self):
        mock_tool = MagicMock()
        mock_tool.name = "test_tool"

        provider = MockToolProvider([mock_tool])
        manager = ToolManager(providers=[provider])
        manager.initialize()

        tool = manager.get_tool("test_tool")
        self.assertEqual(tool, mock_tool)

        tool = manager.get_tool("non_existent")
        self.assertIsNone(tool)

        manager.cleanup()

    def test_execute_tool(self):
        # Test the sync bridge
        manager = ToolManager(providers=[])

        # Mock aexecute_tool to isolate the bridge logic
        manager.aexecute_tool = AsyncMock(return_value="success")

        result = manager.execute_tool("test_tool", {"arg": "value"})
        self.assertEqual(result, "success")
        manager.aexecute_tool.assert_called_with("test_tool", {"arg": "value"})

        manager.cleanup()

    async def test_aexecute_tool(self):
        # Test async execution
        mock_tool = MagicMock()
        mock_tool.name = "async_tool"
        mock_tool.ainvoke = AsyncMock(return_value="async_success")

        provider = MockToolProvider([mock_tool])
        manager = ToolManager(providers=[provider])
        manager.initialize()

        result = await manager.aexecute_tool("async_tool", {"arg": "value"})
        self.assertEqual(result, "async_success")
        mock_tool.ainvoke.assert_called_with({"arg": "value"})

        manager.cleanup()


if __name__ == "__main__":
    unittest.main()
