import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add the parent directory to the Python path to allow module imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.core.llm.service import LLMService


class TestLLMServiceCacheConfig(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.registry_patcher = patch("src.core.llm.service.ModelRegistry")
        self.client_factory_patcher = patch("src.core.llm.service.ClientFactory")
        self.MockRegistry = self.registry_patcher.start()
        self.MockClientFactory = self.client_factory_patcher.start()

        # Setup mocks
        self.mock_registry = self.MockRegistry.return_value
        self.mock_client_factory = self.MockClientFactory.return_value

        self.runner = MagicMock()
        self.runner.start = AsyncMock(side_effect=[8000, 8001, 8002, 8003])
        self.runner.stop = AsyncMock()
        self.runner.cleanup = MagicMock()

        self.mock_registry.get_model_config.return_value = MagicMock()
        mock_model_path = MagicMock(spec=Path)
        mock_model_path.exists.return_value = True
        self.mock_registry.resolve_model_path.return_value = mock_model_path

    def tearDown(self):
        self.registry_patcher.stop()
        self.client_factory_patcher.stop()

    async def test_cache_eviction_with_size_2(self):
        """Test FIFO eviction when cache size is 2."""
        self.mock_client_factory.create_chat_client.side_effect = [
            MagicMock(),
            MagicMock(),
            MagicMock(),
        ]

        service = LLMService(runner=self.runner, cache_size=2)

        # 1) Load Character (Cache: [Character])
        await service.get_client("character")
        self.assertIn("character_model", service._chat_model_cache)

        # 2) Load Executor Default (Cache: [Character, Exec:Default])
        await service.get_client("executor", task_type="default")
        self.assertIn("executor_model:default", service._chat_model_cache)
        self.assertEqual(len(service._chat_model_cache), 2)

        # 3) Load Executor Coding (Cache: [Exec:Default, Exec:Coding]) -> Character evicted
        await service.get_client("executor", task_type="coding")
        self.assertEqual(len(service._chat_model_cache), 2)

        self.runner.stop.assert_called_with("character_model")
        self.assertNotIn("character_model", service._chat_model_cache)
        self.assertIn("executor_model:default", service._chat_model_cache)
        self.assertIn("executor_model:coding", service._chat_model_cache)

        service.cleanup()
        self.runner.cleanup.assert_called_once()


if __name__ == "__main__":
    unittest.main()
