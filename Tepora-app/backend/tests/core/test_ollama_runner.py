import pytest
import respx
from httpx import Response

from src.core.llm.ollama_runner import OllamaRunner
from src.core.llm.runner import RunnerConfig


@pytest.mark.asyncio
async def test_ollama_runner_start_success():
    """Test standard start sequence with existing model."""
    runner = OllamaRunner()

    async with respx.mock:
        # 1. Connection check
        respx.get("http://localhost:11434").mock(return_value=Response(200))
        # 2. List models
        respx.get("http://localhost:11434/api/tags").mock(
            return_value=Response(
                200, json={"models": [{"name": "llama3:latest"}, {"name": "mistral"}]}
            )
        )

        config = RunnerConfig(model_key="llama3")
        port = await runner.start(config)

        assert port == 11434
        assert runner.is_running("llama3")


@pytest.mark.asyncio
async def test_ollama_runner_start_connection_failed():
    """Test start sequence when Ollama is down."""
    runner = OllamaRunner()

    async with respx.mock:
        respx.get("http://localhost:11434").mock(side_effect=Exception("Connection refused"))

        config = RunnerConfig(model_key="llama3")
        with pytest.raises(RuntimeError, match="Cannot connect to Ollama"):
            await runner.start(config)


@pytest.mark.asyncio
async def test_ollama_runner_stop():
    """Test stop (unload) sequence."""
    runner = OllamaRunner()
    # Pre-populate running state
    runner._running_models.add("llama3")

    async with respx.mock:
        route = respx.post("http://localhost:11434/api/chat").mock(return_value=Response(200))

        await runner.stop("llama3")

        assert not runner.is_running("llama3")
        assert route.called
        # Verify payload matches
        import json

        content = json.loads(route.calls.last.request.content)
        assert content["model"] == "llama3"
        assert content["keep_alive"] == 0


@pytest.mark.asyncio
async def test_ollama_runner_get_status():
    runner = OllamaRunner()
    runner._running_models.add("llama3")

    status = runner.get_status("llama3")
    assert status.is_running
    assert status.port == 11434

    status_stopped = runner.get_status("mistral")
    assert not status_stopped.is_running


@pytest.mark.asyncio
async def test_ollama_runner_tokenize():
    """Test tokenize endpoint."""
    runner = OllamaRunner()

    async with respx.mock:
        respx.post("http://localhost:11434/api/tokenize").mock(
            return_value=Response(200, json={"tokens": [1, 2, 3]})
        )

        tokens = await runner.tokenize("hello world", "llama3")
        assert tokens == [1, 2, 3]
