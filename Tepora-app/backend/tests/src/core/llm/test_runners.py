from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.llm.llama_runner import LlamaServerRunner
from src.core.llm.ollama_runner import OllamaRunner


@pytest.fixture
def mock_process_manager():
    with patch("src.core.llm.llama_runner.ProcessManager") as mock_pm:
        yield mock_pm.return_value


@pytest.fixture
def llama_runner(mock_process_manager):
    runner = LlamaServerRunner(binary_path=MagicMock(), logs_dir=MagicMock())
    # Mock get_port directly to simulate running state
    runner.get_port = MagicMock(return_value=8080)
    return runner


@pytest.fixture
def ollama_runner():
    return OllamaRunner(base_url="http://test-ollama:11434")


@pytest.mark.asyncio
async def test_llama_runner_count_tokens(llama_runner):
    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_instance.__aenter__.return_value = mock_instance

        # Create a response mock that is NOT an AsyncMock
        response_mock = MagicMock()
        response_mock.status_code = 200
        response_mock.json.return_value = {"tokens": [1, 2, 3]}

        # Configure post to return this response when awaited
        mock_instance.post = AsyncMock(return_value=response_mock)

        count = await llama_runner.count_tokens("hello world", "test-model")

        assert count == 3
        mock_instance.post.assert_called_with(
            "http://127.0.0.1:8080/tokenize", json={"content": "hello world"}, timeout=5.0
        )


@pytest.mark.asyncio
async def test_llama_runner_get_capabilities(llama_runner):
    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_instance.__aenter__.return_value = mock_instance

        response_mock = MagicMock()
        response_mock.status_code = 200
        response_mock.json.return_value = {
            "chat_template": "{{ message }}",
            "modalities": {"vision": True},
            "model_path": "/path/to/model",
        }

        mock_instance.get = AsyncMock(return_value=response_mock)

        caps = await llama_runner.get_capabilities("test-model")

        assert caps["vision"] is True
        assert caps["chat_template"] == "{{ message }}"
        assert caps["model_path"] == "/path/to/model"


@pytest.mark.asyncio
async def test_ollama_runner_count_tokens(ollama_runner):
    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_instance.__aenter__.return_value = mock_instance

        response_mock = MagicMock()
        response_mock.status_code = 200
        response_mock.json.return_value = {"tokens": [10, 20]}

        mock_instance.post = AsyncMock(return_value=response_mock)

        count = await ollama_runner.count_tokens("test", "llama3")

        assert count == 2
        mock_instance.post.assert_called_with(
            "http://test-ollama:11434/api/tokenize", json={"model": "llama3", "prompt": "test"}
        )


@pytest.mark.asyncio
async def test_ollama_runner_get_capabilities(ollama_runner):
    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_instance.__aenter__.return_value = mock_instance

        response_mock = MagicMock()
        response_mock.status_code = 200
        response_mock.json.return_value = {
            "template": "{{ .Prompt }}",
            "details": {"families": ["llama", "clip"]},
        }

        # Configure post (Ollama uses post for show)
        mock_instance.post = AsyncMock(return_value=response_mock)

        caps = await ollama_runner.get_capabilities("llava")

        assert caps["vision"] is True
        assert caps["chat_template"] == "{{ .Prompt }}"
        assert "raw_show" in caps


@pytest.mark.asyncio
async def test_ollama_runner_preload(ollama_runner):
    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_instance.__aenter__.return_value = mock_instance

        # For preload, we expect a call to /api/generate
        # We don't care about return value
        mock_instance.post = AsyncMock()

        await ollama_runner._preload_model("test-model")

        args, kwargs = mock_instance.post.call_args
        assert "/api/generate" in args[0]
        assert kwargs["json"]["model"] == "test-model"
