import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add the parent directory to the Python path to allow module imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import importlib.util

# --- Mocks for missing dependencies (Minimal for LLMManager) ---
if importlib.util.find_spec("torch") is None:
    sys.modules["torch"] = MagicMock()

if importlib.util.find_spec("langchain_mcp_adapters") is None:
    sys.modules["langchain_mcp_adapters"] = MagicMock()
    sys.modules["langchain_mcp_adapters.client"] = MagicMock()

if importlib.util.find_spec("networkx") is None:
    sys.modules["networkx"] = MagicMock()

if importlib.util.find_spec("sklearn") is None:
    sys.modules["sklearn"] = MagicMock()
    sys.modules["sklearn.metrics"] = MagicMock()
    sys.modules["sklearn.metrics.pairwise"] = MagicMock()

if importlib.util.find_spec("nltk") is None:
    sys.modules["nltk"] = MagicMock()

from src.core.llm_manager import LLMManager


class TestLLMCacheConfig(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.registry_patcher = patch("src.core.llm_manager.ModelRegistry")
        self.process_manager_patcher = patch("src.core.llm_manager.ProcessManager")
        self.client_factory_patcher = patch("src.core.llm_manager.ClientFactory")
        # Patch config!
        self.config_patcher = patch("src.core.llm_manager.config")

        self.MockRegistry = self.registry_patcher.start()
        self.MockProcessManager = self.process_manager_patcher.start()
        self.MockClientFactory = self.client_factory_patcher.start()
        self.mock_config_module = self.config_patcher.start()

        # Setup mocks
        self.mock_registry = self.MockRegistry.return_value
        self.mock_process_manager = self.MockProcessManager.return_value
        self.mock_client_factory = self.MockClientFactory.return_value

        # Common setups
        self.mock_registry.resolve_model_path.return_value = MagicMock(
            spec=Path, exists=lambda: True
        )
        self.mock_registry.resolve_binary_path.return_value = MagicMock(spec=Path)
        self.mock_registry.resolve_logs_dir.return_value = MagicMock(spec=Path)
        self.mock_registry.resolve_logs_dir.return_value.__truediv__.return_value = MagicMock(
            spec=Path
        )

    def tearDown(self):
        self.registry_patcher.stop()
        self.process_manager_patcher.stop()
        self.client_factory_patcher.stop()
        self.config_patcher.stop()

    async def test_cache_size_read_from_config(self):
        """Test that cache_size is initialized from config."""
        self.mock_config_module.settings.llm_manager.cache_size = 5
        manager = LLMManager()
        self.assertEqual(manager._cache_size, 5)

    async def test_cache_eviction_with_size_2(self):
        """Test proper eviction when cache size is 2."""
        # Set cache size to 2
        self.mock_config_module.settings.llm_manager.cache_size = 2

        manager = LLMManager()

        # Mocks for loading
        self.mock_registry.get_model_config.return_value = MagicMock()
        self.mock_process_manager.find_free_port.side_effect = [8000, 8001, 8002, 8003]

        # 1. Load Character (Cache: [Character])
        print("Loading Character Model...")
        await manager.get_character_model()
        self.assertIn("character_model", manager._chat_model_cache)
        self.assertEqual(len(manager._chat_model_cache), 1)

        # 2. Load Executor Default (Cache: [Character, Exec:Default])
        print("Loading Executor Default...")
        await manager.get_executor_model("default")
        self.assertIn("executor_model:default", manager._chat_model_cache)
        self.assertEqual(len(manager._chat_model_cache), 2)

        # Verify Character still there
        self.assertIn("character_model", manager._chat_model_cache)

        # 3. Load Executor Coding (Cache: [Exec:Default, Exec:Coding]) -> Character evicted
        print("Loading Executor Coding...")
        await manager.get_executor_model("coding")
        self.assertEqual(len(manager._chat_model_cache), 2)

        # Character was the oldest, should be evicted (assuming simple insertion order dict iteration)
        self.assertNotIn("character_model", manager._chat_model_cache)
        self.assertIn("executor_model:default", manager._chat_model_cache)
        self.assertIn("executor_model:coding", manager._chat_model_cache)


if __name__ == "__main__":
    unittest.main()
