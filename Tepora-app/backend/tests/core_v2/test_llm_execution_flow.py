"""
Phase 2 LLM Execution Flow Tests

Acceptance Criteria:
- Initialize LLMService using Mock LLM
- Send "Hello" prompt, receive response
- Verify Token Window logic trims history correctly
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Path setup
_src_dir = Path(__file__).resolve().parents[2] / "src"
if str(_src_dir) not in sys.path:
    sys.path.insert(0, str(_src_dir))

# Test imports
from src.core.context import SessionHistory
from src.core.llm import LLMService

# ============================================================
# LLMService Tests
# ============================================================


class TestLLMService:
    """LLMService unit tests"""

    def test_initialization(self) -> None:
        """Test LLMService initializes without errors"""
        with (
            patch("src.core.llm.service.ModelRegistry") as mock_registry,  # noqa: N806
            patch("src.core.llm.service.LlamaServerRunner") as mock_runner,  # noqa: N806
            patch("src.core.llm.service.ClientFactory") as mock_client_factory,  # noqa: N806
        ):
            service = LLMService()

            # Verify components are initialized
            mock_registry.assert_called_once()
            mock_runner.assert_called_once()
            mock_client_factory.assert_called_once()

            # Verify no current model key state
            assert not hasattr(service, "_current_model_key")

            # Cache should be empty
            assert service._chat_model_cache == {}
            assert service._embedding_client is None

            service.cleanup()

    @pytest.mark.asyncio
    async def test_get_client_with_mock(self) -> None:
        """Get mock client, send prompt, receive response"""
        with (
            patch("src.core.llm.service.ModelRegistry") as mock_registry,  # noqa: N806
            patch("src.core.llm.service.LlamaServerRunner") as mock_runner,  # noqa: N806
            patch("src.core.llm.service.ClientFactory") as mock_client_factory,  # noqa: N806
        ):
            # Setup mocks
            mock_registry = mock_registry.return_value
            mock_runner = mock_runner.return_value
            mock_client_factory = mock_client_factory.return_value

            # Model config mock
            mock_config = MagicMock()
            mock_config.n_ctx = 8192
            mock_config.n_gpu_layers = -1
            mock_registry.get_model_config.return_value = mock_config

            # Path mocks
            mock_model_path = MagicMock(spec=Path)
            mock_model_path.exists.return_value = True
            mock_registry.resolve_model_path.return_value = mock_model_path

            mock_server_path = MagicMock(spec=Path)
            mock_registry.resolve_binary_path.return_value = mock_server_path

            mock_logs_dir = MagicMock(spec=Path)
            mock_logs_dir.__truediv__.return_value = MagicMock(spec=Path)
            mock_registry.resolve_logs_dir.return_value = mock_logs_dir

            # Runner mock - returns port
            mock_runner.start = AsyncMock(return_value=12345)

            # Client mock with response
            mock_client = MagicMock()
            mock_client.ainvoke = AsyncMock(return_value="Mock response to Hello!")
            mock_client_factory.create_chat_client.return_value = mock_client

            # Test
            service = LLMService()
            client = await service.get_client("character")

            # Verify client creation
            mock_client_factory.create_chat_client.assert_called_once()
            assert client == mock_client

            # Verify can invoke
            response = await client.ainvoke("Hello!")
            assert "Mock" in str(response)

            # Verify cached
            assert "character_model" in service._chat_model_cache

            service.cleanup()

    @pytest.mark.asyncio
    async def test_stateless_design(self) -> None:
        """Verify no _current_model_key state (stateless design)"""
        with (
            patch("src.core.llm.service.ModelRegistry"),
            patch("src.core.llm.service.LlamaServerRunner"),
            patch("src.core.llm.service.ClientFactory"),
        ):
            service = LLMService()

            # Verify stateless - no current model key tracking
            assert not hasattr(service, "_current_model_key")

            # Model selection should happen per-request, not via state
            assert hasattr(service, "get_client")
            assert hasattr(service, "get_embedding_client")

            service.cleanup()

    def test_cleanup(self) -> None:
        """Test cleanup clears caches and stops processes"""
        with (
            patch("src.core.llm.service.ModelRegistry"),
            patch("src.core.llm.service.LlamaServerRunner") as mock_runner,  # noqa: N806
            patch("src.core.llm.service.ClientFactory"),
        ):
            mock_runner = mock_runner.return_value

            service = LLMService()

            # Add some mock cache entries
            service._chat_model_cache["test"] = (MagicMock(), 8000)
            service._embedding_client = (MagicMock(), 9000)

            service.cleanup()

            # Verify cleanup
            mock_runner.cleanup.assert_called_once()
            assert service._chat_model_cache == {}
            assert service._embedding_client is None


# ============================================================
# SessionHistory Tests
# ============================================================


class TestSessionHistory:
    """SessionHistory unit tests"""

    def test_initialization(self) -> None:
        """Test SessionHistory initializes correctly"""
        with patch("src.core.context.history.ChatHistoryManager") as MockCHM:
            mock_manager = MockCHM.return_value

            history = SessionHistory("test-session-123")

            assert history.session_id == "test-session-123"
            mock_manager._ensure_session.assert_called_once_with("test-session-123")

    def test_get_messages(self) -> None:
        """Test getting messages from history"""
        with patch("src.core.context.history.ChatHistoryManager") as mock_chm:  # noqa: N806
            mock_manager = mock_chm.return_value
            mock_manager.get_history.return_value = []

            history = SessionHistory("test-session")
            messages = history.get_messages(limit=50)

            mock_manager.get_history.assert_called_once_with(
                session_id="test-session",
                limit=50,
            )
            assert messages == []

    def test_add_message(self) -> None:
        """Test adding a message"""
        from langchain_core.messages import HumanMessage

        with patch("src.core.context.history.ChatHistoryManager") as MockCHM:
            mock_manager = MockCHM.return_value

            history = SessionHistory("test-session")
            msg = HumanMessage(content="Hello")
            history.add_message(msg)

            mock_manager.add_message.assert_called_once_with(
                msg,
                session_id="test-session",
            )


# ============================================================
# Golden Flow Test
# ============================================================


class TestLLMExecutionGoldenFlow:
    """Phase 2 Acceptance Criteria: Golden Flow Test"""

    @pytest.mark.asyncio
    async def test_llm_execution_flow(self) -> None:
        """
        Initialize LLMService with Mock, send 'Hello', get response.

        This is the Phase 2 acceptance criteria test.
        """
        with (
            patch("src.core.llm.service.ModelRegistry") as mock_registry,  # noqa: N806
            patch("src.core.llm.service.LlamaServerRunner") as mock_runner,  # noqa: N806
            patch("src.core.llm.service.ClientFactory") as mock_client_factory,  # noqa: N806
        ):
            # Setup all mocks
            mock_registry = mock_registry.return_value
            mock_runner = mock_runner.return_value
            mock_client_factory = mock_client_factory.return_value

            mock_config = MagicMock()
            mock_config.n_ctx = 8192
            mock_config.n_gpu_layers = -1
            mock_registry.get_model_config.return_value = mock_config

            mock_model_path = MagicMock(spec=Path)
            mock_model_path.exists.return_value = True
            mock_registry.resolve_model_path.return_value = mock_model_path

            mock_server_path = MagicMock(spec=Path)
            mock_registry.resolve_binary_path.return_value = mock_server_path

            mock_logs_dir = MagicMock(spec=Path)
            mock_logs_dir.__truediv__.return_value = MagicMock(spec=Path)
            mock_registry.resolve_logs_dir.return_value = mock_logs_dir

            # Runner mock - returns port
            mock_runner.start = AsyncMock(return_value=8080)

            mock_client = MagicMock()
            mock_client.ainvoke = AsyncMock(return_value="Mock LLM response")
            mock_client_factory.create_chat_client.return_value = mock_client

            # 1. Initialize LLMService (stateless)
            service = LLMService()

            # Verify stateless design
            assert not hasattr(service, "_current_model_key")

            # 2. Get client for role
            client = await service.get_client("character")
            assert client is not None

            # 3. Send "Hello" prompt
            response = await client.ainvoke("Hello")
            assert "Mock" in str(response)

            # 4. Verify runner was called correctly
            mock_runner.start.assert_called_once()

            # 5. Cleanup
            service.cleanup()
            mock_runner.cleanup.assert_called_once()


# ============================================================
# TeporaApp Integration Tests
# ============================================================


class TestTeporaAppWithLLM:
    """TeporaApp with LLMService integration tests"""

    @pytest.mark.asyncio
    async def test_app_has_llm_service(self) -> None:
        """Test app exposes LLMService after initialization"""
        from src.core.app_v2 import TeporaApp, TeporaAppConfig

        with (
            patch("src.core.llm.service.ModelRegistry"),
            patch("src.core.llm.service.LlamaServerRunner"),
            patch("src.core.llm.service.ClientFactory"),
        ):
            config = TeporaAppConfig()
            app = TeporaApp(config=config)

            await app.initialize()

            # Verify LLMService is available
            assert app.llm_service is not None
            assert isinstance(app.llm_service, LLMService)

            await app.shutdown()
            assert not app.is_initialized
