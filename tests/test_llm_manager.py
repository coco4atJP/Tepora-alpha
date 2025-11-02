import unittest
from unittest.mock import patch, MagicMock, call
import sys
from pathlib import Path
import platform
import torch
import subprocess
import requests

# Add the parent directory to the Python path to allow module imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from Tepora_app.agent_core.llm_manager import LLMManager
from Tepora_app.agent_core import config as agent_config

class TestLLMManager(unittest.TestCase):

    def setUp(self):
        """Set up a fresh LLMManager instance for each test."""
        # Mock the config module to have predictable values
        self.mock_config = MagicMock()
        self.mock_config.MODELS_GGUF = {
            "gemma_3n": {
                "port": 8000,
                "path": "models/gemma-3n.gguf",
                "n_ctx": 4096,
                "n_gpu_layers": -1,
                "logprobs": True,
            },
            "embedding_model": {
                "port": 8003,
                "path": "models/embedding.gguf",
                "n_ctx": 4096,
                "n_gpu_layers": -1,
            },
        }
        self.mock_config.LLAMA_CPP_CONFIG = {
            "health_check_timeout": 2,
            "health_check_interval": 0.1,
            "process_terminate_timeout": 1,
            "embedding_health_check_timeout": 2,
        }

        # Patch the config module used by llm_manager
        self.config_patcher = patch('Tepora_app.agent_core.llm_manager.config', self.mock_config)
        self.mock_config_instance = self.config_patcher.start()

        self.manager = LLMManager()

    def tearDown(self):
        """Clean up by stopping the patcher."""
        self.config_patcher.stop()
        # Ensure cleanup is called, but only if a process was mocked
        if self.manager._active_process or self.manager._embedding_process:
            self.manager.cleanup()

    def test_initialization(self):
        """Test that the LLMManager initializes with default empty values."""
        self.assertIsNone(self.manager._current_model_key)
        self.assertIsNone(self.manager._chat_llm)
        self.assertIsNone(self.manager._active_process)
        self.assertIsNone(self.manager._embedding_llm)
        self.assertIsNone(self.manager._embedding_process)

    @patch('pathlib.Path.glob')
    @patch('pathlib.Path.stat')
    def test_find_server_executable_prefers_version_and_env(self, mock_stat, mock_glob):
        """Test the server executable finding logic."""
        # Mock file stats (mtime)
        mock_stat.return_value.st_mtime = 1.0

        # Mock found files
        mock_files = [
            Path("llama.cpp/llama-b100-bin-win-cpu-x64/llama-server.exe"),
            Path("llama.cpp/llama-b200-bin-win-cuda-x64/llama-server.exe"), # Highest version and best env
            Path("llama.cpp/llama-b150-bin-win-vulkan-x64/llama-server.exe"),
        ]
        mock_glob.return_value = mock_files

        with patch('torch.cuda.is_available', return_value=True), \
             patch('sys.platform', "win32"):
            result = self.manager._find_server_executable(Path("llama.cpp/"))
            self.assertEqual(result, mock_files[1])

    @patch('requests.get')
    def test_perform_health_check_success(self, mock_get):
        """Test health check success on the first try."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"status": "ok"}
        mock_get.return_value = mock_response

        try:
            self.manager._perform_health_check(8000, "test_model")
        except TimeoutError:
            self.fail("_perform_health_check raised TimeoutError unexpectedly.")
        mock_get.assert_called_once_with("http://localhost:8000/health", timeout=0.5)

    @patch('requests.get')
    def test_perform_health_check_retry_and_fail(self, mock_get):
        """Test that health check retries and eventually fails."""
        mock_get.side_effect = requests.exceptions.RequestException("Connection failed")

        # We need to reduce the timeout for the test to run quickly
        self.mock_config_instance.LLAMA_CPP_CONFIG['health_check_timeout'] = 0.3
        self.mock_config_instance.LLAMA_CPP_CONFIG['health_check_interval'] = 0.1

        with self.assertRaises(TimeoutError):
            self.manager._perform_health_check(8000, "test_model")

        # Check that it was called multiple times
        self.assertGreater(mock_get.call_count, 1)

    @patch('subprocess.Popen')
    @patch('pathlib.Path.exists', return_value=True)
    @patch.object(LLMManager, '_find_server_executable', return_value=Path("path/to/server"))
    @patch.object(LLMManager, '_perform_health_check', return_value=None)
    @patch('Tepora_app.agent_core.llm_manager.ChatOpenAI')
    def test_load_model_success(self, mock_chat_openai, mock_health_check, mock_find_server, mock_path_exists, mock_popen):
        """Test the successful loading of a chat model."""
        mock_process = MagicMock()
        mock_popen.return_value = mock_process

        # Action
        llm = self.manager.get_character_agent()

        # Assertions
        mock_find_server.assert_called_once()
        mock_popen.assert_called_once()
        mock_health_check.assert_called_once_with(8000, "gemma_3n", unittest.mock.ANY)
        mock_chat_openai.assert_called_once()
        self.assertIsNotNone(llm)
        self.assertEqual(self.manager._current_model_key, "gemma_3n")
        self.assertEqual(self.manager._active_process, mock_process)

    @patch('subprocess.Popen')
    @patch('pathlib.Path.exists', return_value=True)
    @patch.object(LLMManager, '_find_server_executable', return_value=Path("path/to/server"))
    @patch.object(LLMManager, '_perform_health_check', return_value=None)
    @patch('Tepora_app.agent_core.llm_manager.OpenAIEmbeddings')
    def test_get_embedding_model_success(self, mock_embeddings, mock_health_check, mock_find_server, mock_path_exists, mock_popen):
        """Test the successful loading of the embedding model."""
        mock_process = MagicMock()
        mock_popen.return_value = mock_process

        # Action
        embedding_llm = self.manager.get_embedding_model()

        # Assertions
        mock_popen.assert_called_once()
        command = mock_popen.call_args[0][0]
        self.assertIn("--embedding", command) # Check for embedding flag
        mock_health_check.assert_called_once_with(8003, "embedding_model", unittest.mock.ANY)
        mock_embeddings.assert_called_once()
        self.assertIsNotNone(embedding_llm)
        self.assertIsNotNone(self.manager._embedding_llm)
        self.assertEqual(self.manager._embedding_process, mock_process)

        # Test caching
        embedding_llm2 = self.manager.get_embedding_model()
        self.assertIs(embedding_llm, embedding_llm2)
        mock_popen.assert_called_once() # Should not be called again

    def test_cleanup(self):
        """Test that the cleanup method properly unloads all models."""
        # Mock loaded models and processes
        mock_chat_process = MagicMock(spec=subprocess.Popen)
        mock_chat_process.pid = 1234
        self.manager._active_process = mock_chat_process

        mock_embedding_process = MagicMock(spec=subprocess.Popen)
        mock_embedding_process.pid = 5678
        self.manager._embedding_process = mock_embedding_process

        self.manager._current_model_key = "gemma_3n"
        self.manager._embedding_llm = MagicMock()

        # Action
        self.manager.cleanup()

        # Assertions
        mock_chat_process.terminate.assert_called_once()
        mock_embedding_process.terminate.assert_called_once()
        self.assertIsNone(self.manager._active_process)
        self.assertIsNone(self.manager._embedding_process)
        self.assertIsNone(self.manager._current_model_key)
        self.assertIsNone(self.manager._chat_llm)
        self.assertIsNone(self.manager._embedding_llm)

if __name__ == '__main__':
    unittest.main()
