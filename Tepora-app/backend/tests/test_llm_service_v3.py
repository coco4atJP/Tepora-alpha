import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add parent directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.core.llm.service import LLMService
from src.core.models.types import ModelInfo, ModelLoader, ModelModality


class TestLLMServiceV3(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Mock ModelManager
        self.mock_manager = MagicMock()

        # Mock Runners
        self.mock_llama_runner = MagicMock()
        self.mock_llama_runner.start = AsyncMock(return_value=8000)
        self.mock_llama_runner.stop = AsyncMock()
        self.mock_llama_runner.get_base_url = MagicMock(return_value=None)
        self.mock_llama_runner.cleanup = MagicMock()

        self.mock_ollama_runner = MagicMock()
        self.mock_ollama_runner.start = AsyncMock(return_value=11434)
        self.mock_ollama_runner.stop = AsyncMock()
        self.mock_ollama_runner.get_base_url = MagicMock(return_value=None)
        self.mock_ollama_runner.cleanup = MagicMock()

        # Patch LlamaServerRunner and OllamaRunner construction
        self.llama_patcher = patch(
            "src.core.llm.service.LlamaServerRunner", return_value=self.mock_llama_runner
        )
        self.ollama_patcher = patch(
            "src.core.llm.service.OllamaRunner", return_value=self.mock_ollama_runner
        )
        self.llama_patcher.start()
        self.ollama_patcher.start()

        self.service = LLMService(model_manager=self.mock_manager, cache_size=3)
        # Manually force runners to mocks (in case init logic created new ones despite patch)
        self.service._llama_runner = self.mock_llama_runner
        self.service._ollama_runner = self.mock_ollama_runner

        self._tmp_files: list[str] = []

    def tearDown(self):
        self.service.cleanup()
        self.llama_patcher.stop()
        self.ollama_patcher.stop()
        for p in self._tmp_files:
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:
                pass

    def _tmp_gguf(self) -> str:
        f = tempfile.NamedTemporaryFile(delete=False, suffix=".gguf")
        f.close()
        self._tmp_files.append(f.name)
        return f.name

    async def test_get_client_by_id_llama(self):
        """Test retrieving a llama.cpp model by ID."""
        model_id = "test-llama-123"
        info = ModelInfo(
            id=model_id,
            name="Test Llama",
            loader=ModelLoader.LLAMA_CPP,
            path=self._tmp_gguf(),
            modality=ModelModality.TEXT,
        )
        self.mock_manager.get_model.return_value = info

        # Execute
        client = await self.service.get_client(role="unused", model_id=model_id)

        # Verify
        self.mock_manager.get_model.assert_called_with(model_id)
        self.mock_llama_runner.start.assert_called_once()
        self.mock_ollama_runner.start.assert_not_called()
        self.assertIsNotNone(client)

    async def test_get_client_by_id_ollama(self):
        """Test retrieving an ollama model by ID."""
        model_id = "test-ollama-456"
        info = ModelInfo(
            id=model_id,
            name="Test Ollama",
            loader=ModelLoader.OLLAMA,
            path="llama3:latest",
            modality=ModelModality.TEXT,
        )
        self.mock_manager.get_model.return_value = info

        # Execute
        await self.service.get_client(role="unused", model_id=model_id)

        # Verify
        self.mock_manager.get_model.assert_called_with(model_id)
        self.mock_ollama_runner.start.assert_called_once()
        self.mock_llama_runner.start.assert_not_called()

    async def test_get_client_by_role(self):
        """Test retrieving a model via role lookup."""
        mock_id = "resolved-id"
        self.mock_manager.get_assigned_model_id.return_value = mock_id

        info = ModelInfo(
            id=mock_id,
            name="Role Model",
            loader=ModelLoader.LLAMA_CPP,
            path=self._tmp_gguf(),
            modality=ModelModality.TEXT,
        )
        self.mock_manager.get_model.return_value = info

        # Execute
        await self.service.get_client(role="character")

        # Verify
        self.mock_manager.get_assigned_model_id.assert_called_with("character")
        self.mock_manager.get_model.assert_called_with(mock_id)

    async def test_eviction_mixed_loaders(self):
        """Test eviction works across different loaders."""
        self.service._cache_size = 1

        # 1. Load Llama
        id1 = "llama-1"
        info1 = ModelInfo(
            id=id1,
            name="L1",
            loader=ModelLoader.LLAMA_CPP,
            path=self._tmp_gguf(),
            modality=ModelModality.TEXT,
        )
        self.mock_manager.get_model.side_effect = lambda mid: info1 if mid == id1 else None

        await self.service.get_client(role="u", model_id=id1)
        self.mock_llama_runner.start.assert_called_once()

        # 2. Load Ollama (should evict Llama)
        id2 = "ollama-2"
        info2 = ModelInfo(
            id=id2, name="O2", loader=ModelLoader.OLLAMA, path="p2", modality=ModelModality.TEXT
        )
        self.mock_manager.get_model.side_effect = (
            lambda mid: info2 if mid == id2 else (info1 if mid == id1 else None)
        )

        await self.service.get_client(role="u", model_id=id2)

        # Verify Llama stopped and Ollama started
        self.mock_llama_runner.stop.assert_called_with(id1)
        self.mock_ollama_runner.start.assert_called_once()

        self.assertNotIn(id1, self.service._chat_model_cache)
        self.assertIn(id2, self.service._chat_model_cache)


if __name__ == "__main__":
    unittest.main()
