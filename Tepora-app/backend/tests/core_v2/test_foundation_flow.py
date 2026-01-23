"""
Phase 1 Foundation Flow Tests

Acceptance Criteria:
- V2 App can load settings from src/core/config
- ToolManager can register and execute tools
- TeporaApp initialization and shutdown work correctly
"""

from __future__ import annotations

# Path setup - must be before any core_v2 imports
import sys
from pathlib import Path

_src_dir = Path(__file__).resolve().parents[2] / "src"
if str(_src_dir) not in sys.path:
    sys.path.insert(0, str(_src_dir))


import pytest
from langchain_core.tools import BaseTool

# Test imports from core_v2
from src.core.app_v2 import TeporaApp, TeporaAppConfig
from src.core.system import SessionManager, get_logger
from src.core.system.logging import PIIFilter
from src.core.tools import ToolManager, ToolProvider

# ============================================================
# Mock Tool for Testing
# ============================================================


class MockTool(BaseTool):
    """Mock tool for testing"""

    name: str = "mock_tool"
    description: str = "A mock tool for testing"

    def _run(self, query: str) -> str:
        return f"Mock response for: {query}"

    async def _arun(self, query: str) -> str:
        return f"Async mock response for: {query}"


class MockToolProvider(ToolProvider):
    """Mock ToolProvider for testing"""

    @property
    def name(self) -> str:
        """Return provider name."""
        return "mock"

    async def load_tools(self) -> list[BaseTool]:
        return [MockTool()]

    def cleanup(self) -> None:
        pass


# ============================================================
# System Module Tests
# ============================================================


class TestLogging:
    """Logging module tests"""

    def test_get_logger(self) -> None:
        """Test logger retrieval"""
        log = get_logger("test.module")
        assert log is not None
        assert log.name == "test.module"

    def test_pii_filter_email(self) -> None:
        """PII Filter - Email redaction"""
        pii_filter = PIIFilter(enabled=True)

        class MockRecord:
            msg = "Contact me at test@example.com"
            args = ()

        record = MockRecord()
        pii_filter.filter(record)  # type: ignore
        assert "[EMAIL]" in record.msg
        assert "test@example.com" not in record.msg

    def test_pii_filter_phone_jp(self) -> None:
        """PII Filter - Japanese phone number redaction"""
        pii_filter = PIIFilter(enabled=True)

        class MockRecord:
            msg = "Call me at 03-1234-5678"
            args = ()

        record = MockRecord()
        pii_filter.filter(record)  # type: ignore
        assert "[PHONE]" in record.msg

    def test_pii_filter_disabled(self) -> None:
        """PII Filter - No changes when disabled"""
        pii_filter = PIIFilter(enabled=False)

        class MockRecord:
            msg = "Contact me at test@example.com"
            args = ()

        record = MockRecord()
        pii_filter.filter(record)  # type: ignore
        assert "test@example.com" in record.msg


class TestSessionManager:
    """Session manager tests"""

    def test_get_session_resources(self) -> None:
        """Get session resources"""
        manager = SessionManager()
        resources = manager.get_session_resources("test-session-1")

        assert resources.session_id == "test-session-1"
        assert manager.active_session_count == 1

    def test_release_session(self) -> None:
        """Release session"""
        manager = SessionManager()
        manager.get_session_resources("test-session-1")
        manager.get_session_resources("test-session-2")

        assert manager.active_session_count == 2

        released = manager.release_session("test-session-1")
        assert released is True
        assert manager.active_session_count == 1

        # Release nonexistent session
        released = manager.release_session("nonexistent")
        assert released is False

    def test_list_active_sessions(self) -> None:
        """List active sessions"""
        manager = SessionManager()
        manager.get_session_resources("session-a")
        manager.get_session_resources("session-b")

        sessions = manager.list_active_sessions()
        assert "session-a" in sessions
        assert "session-b" in sessions


# ============================================================
# Tools Module Tests
# ============================================================


class TestToolManager:
    """ToolManager tests"""

    def test_initialize_with_provider(self) -> None:
        """Initialize tools from provider"""
        provider = MockToolProvider()
        manager = ToolManager(providers=[provider])

        manager.initialize()

        assert len(manager.tools) == 1
        assert "mock_tool" in manager.tool_map

        manager.cleanup()

    def test_get_tool(self) -> None:
        """Get tool"""
        provider = MockToolProvider()
        manager = ToolManager(providers=[provider])
        manager.initialize()

        tool = manager.get_tool("mock_tool")
        assert tool is not None
        assert tool.name == "mock_tool"

        # Nonexistent tool
        assert manager.get_tool("nonexistent") is None

        manager.cleanup()

    def test_list_tools(self) -> None:
        """List tools"""
        provider = MockToolProvider()
        manager = ToolManager(providers=[provider])
        manager.initialize()

        tools = manager.list_tools()
        assert "mock_tool" in tools

        manager.cleanup()

    def test_execute_tool_sync(self) -> None:
        """Execute tool synchronously"""
        provider = MockToolProvider()
        manager = ToolManager(providers=[provider])
        manager.initialize()

        result = manager.execute_tool("mock_tool", {"query": "test"})
        assert "Mock response for: test" in str(result) or "test" in str(result)

        manager.cleanup()

    def test_execute_nonexistent_tool(self) -> None:
        """Execute nonexistent tool"""
        manager = ToolManager(providers=[])
        manager.initialize()

        result = manager.execute_tool("nonexistent", {})
        assert "error" in str(result).lower() or "not found" in str(result).lower()

        manager.cleanup()


# ============================================================
# TeporaApp Tests
# ============================================================


class TestTeporaApp:
    """TeporaApp tests"""

    @pytest.mark.asyncio
    async def test_app_initialization(self) -> None:
        """App initialization"""
        config = TeporaAppConfig(tool_providers=[MockToolProvider()])
        app = TeporaApp(config=config)

        assert not app.is_initialized

        await app.initialize()

        assert app.is_initialized
        assert app.session_manager is not None
        assert app.tool_manager is not None

        await app.shutdown()
        assert not app.is_initialized

    @pytest.mark.asyncio
    async def test_app_context_manager(self) -> None:
        """Use as context manager"""
        config = TeporaAppConfig(tool_providers=[MockToolProvider()])

        async with TeporaApp(config=config) as app:
            assert app.is_initialized
            assert len(app.tool_manager.tools) == 1

        assert not app.is_initialized

    @pytest.mark.asyncio
    async def test_app_process_message(self) -> None:
        """Process message (Phase 3 with Graph)"""
        from unittest.mock import MagicMock, patch

        config = TeporaAppConfig(tool_providers=[MockToolProvider()])

        # Mock the entire TeporaGraph to avoid complex LLM mocking
        with patch("src.core.app_v2.TeporaGraph") as MockGraph:
            mock_graph_instance = MockGraph.return_value
            mock_graph_instance.cleanup = MagicMock()

            # Mock the process method to yield strings
            async def mock_process(*args, **kwargs):
                yield "Hello "
                yield "World!"

            mock_graph_instance.process = mock_process

            # Also mock LLMService to prevent initialization errors
            with patch("src.core.app_v2.LLMService") as MockLLMService:
                mock_llm = MockLLMService.return_value
                mock_llm.cleanup = MagicMock()

                async with TeporaApp(config=config) as app:
                    chunks = []
                    async for chunk in app.process_message("test-session", "Hello!"):
                        chunks.append(chunk)

                    response = "".join(chunks)
                    assert response == "Hello World!"

    @pytest.mark.asyncio
    async def test_app_not_initialized_error(self) -> None:
        """Error when not initialized"""
        app = TeporaApp()

        with pytest.raises(RuntimeError, match="not initialized"):
            _ = app.session_manager

        with pytest.raises(RuntimeError, match="not initialized"):
            _ = app.tool_manager


# ============================================================
# Golden Flow Test
# ============================================================


class TestFoundationGoldenFlow:
    """Phase 1 Acceptance Criteria: Golden Flow Test"""

    @pytest.mark.asyncio
    async def test_foundation_flow(self) -> None:
        """
        V2 App can load config and execute tools via ToolManager.

        This is the Phase 1 acceptance criteria test.
        """
        # 1. Load settings (verify core/config is importable)
        from src.core.config import settings

        assert settings is not None

        # 2. Prepare ToolProvider
        provider = MockToolProvider()

        # 3. Initialize TeporaApp
        config = TeporaAppConfig(
            tool_providers=[provider],
            tool_timeout=10,
        )

        async with TeporaApp(config=config) as app:
            # 4. Verify ToolManager is initialized
            assert app.tool_manager is not None
            assert len(app.tool_manager.tools) > 0

            # 5. Execute tool
            result = await app.execute_tool("mock_tool", {"query": "golden flow test"})
            assert "mock" in str(result).lower() or "golden flow test" in str(result)

            # 6. Session management
            resources = app.session_manager.get_session_resources("golden-test")
            assert resources.session_id == "golden-test"

        # 7. Verify cleanup
        assert not app.is_initialized
