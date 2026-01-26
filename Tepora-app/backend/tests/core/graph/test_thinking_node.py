from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda

from src.core.graph.nodes.thinking import ThinkingNode
from src.core.graph.state import create_initial_state


@pytest.fixture
def mock_llm_service():
    service = MagicMock()
    service.get_client = AsyncMock()
    return service


@pytest.mark.asyncio
async def test_thinking_node_enabled(mock_llm_service):
    # Setup
    node = ThinkingNode(mock_llm_service)

    # Mock LLM response using RunnableLambda to support '|' operator
    async def mock_invoke(input):
        return AIMessage(content="Thought process step 1... step 2...")

    mock_client = RunnableLambda(mock_invoke)
    mock_llm_service.get_client.return_value = mock_client

    # State with thinking_mode=True
    state = create_initial_state("test-session", "test input")
    state["thinking_mode"] = True

    # Execute
    result = await node.thinking_node(state)

    # Verify
    assert "thought_process" in result
    assert result["thought_process"] == "Thought process step 1... step 2..."
    mock_llm_service.get_client.assert_called_with("character")


@pytest.mark.asyncio
async def test_thinking_node_disabled(mock_llm_service):
    # Setup
    node = ThinkingNode(mock_llm_service)

    # State with thinking_mode=False
    state = create_initial_state("test-session", "test input")
    state["thinking_mode"] = False

    # Execute
    result = await node.thinking_node(state)

    # Verify
    assert result == {}
    mock_llm_service.get_client.assert_not_called()


@pytest.mark.asyncio
async def test_thinking_node_none(mock_llm_service):
    # Setup
    node = ThinkingNode(mock_llm_service)

    # State with thinking_mode=None
    state = create_initial_state("test-session", "test input")
    state["thinking_mode"] = None

    # Execute
    result = await node.thinking_node(state)

    # Verify
    assert result == {}
    mock_llm_service.get_client.assert_not_called()
