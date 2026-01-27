import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add the parent directory to the Python path to allow module imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tempfile

from src.core.llm.service import LLMService
from src.core.models import ModelManager
from src.core.models.types import ModelConfig, ModelInfo, ModelLoader, ModelModality


class TestLLMServiceCacheConfig(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client_factory_patcher = patch("src.core.llm.service.ClientFactory")
        self.MockClientFactory = self.client_factory_patcher.start()
        self.mock_client_factory = self.MockClientFactory.return_value

        self.runner = MagicMock()
        self.runner.start = AsyncMock(side_effect=[8000, 8001, 8002, 8003])
        self.runner.stop = AsyncMock()
        self.runner.cleanup = MagicMock()

        self.mock_model_manager = MagicMock(spec=ModelManager)

        # Create a dummy model file
        self.temp_model_file = tempfile.NamedTemporaryFile(delete=False)
        self.temp_model_path = self.temp_model_file.name
        self.temp_model_file.close()

        self.mock_config = ModelConfig()

        def get_model_side_effect(model_id):
            return ModelInfo(
                id=model_id,
                name=f"Mock Model {model_id}",
                loader=ModelLoader.LLAMA_CPP,
                path=self.temp_model_path,
                modality=ModelModality.TEXT,
                config=self.mock_config,
            )

        self.mock_model_manager.get_model.side_effect = get_model_side_effect

        def role_mapper(role):
            if role == "character":
                return "character_model"
            if role == "executor":
                return "executor_model:default"
            if role == "executor:coding":
                return "executor_model:coding"
            return f"{role}_model"

        self.mock_model_manager.get_assigned_model_id.side_effect = role_mapper

        self.mock_model_manager.get_binary_path.return_value = Path("/bin/true")
        self.mock_model_manager.get_logs_dir.return_value = Path("/tmp")

    def tearDown(self):
        self.client_factory_patcher.stop()
        Path(self.temp_model_path).unlink(missing_ok=True)

    async def test_cache_eviction_with_size_2(self):
        """Test FIFO eviction when cache size is 2."""
        self.mock_client_factory.create_chat_client.side_effect = [
            MagicMock(),
            MagicMock(),
            MagicMock(),
        ]

        service = LLMService(
            runner=self.runner, model_manager=self.mock_model_manager, cache_size=2
        )

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
        self.assertEqual(self.runner.cleanup.call_count, 2)


if __name__ == "__main__":
    unittest.main()
