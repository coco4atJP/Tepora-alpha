"""
Base Agent - Abstract Interface for Specialized Agents

Defines the interface for compiled graph agents.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.core.graph.state import AgentState

logger = logging.getLogger(__name__)


class BaseAgent(ABC):
    """
    Abstract base class for specialized agents.

    Agents are isolated SubGraphs that handle specific task types.
    They receive an AgentState and produce streaming responses.

    Implementations:
    - CodingAgent: Code-related tasks (Phase 4+)
    - ResearchAgent: Research and analysis (Phase 4+)
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Agent name identifier."""
        ...

    @property
    @abstractmethod
    def description(self) -> str:
        """Agent description."""
        ...

    @abstractmethod
    async def execute(self, state: AgentState) -> dict[str, Any]:
        """
        Execute agent logic on the given state.

        Args:
            state: Current agent state

        Returns:
            Updated state fields
        """
        ...

    async def stream(self, state: AgentState) -> AsyncIterator[str]:
        """
        Stream agent output.

        Default implementation yields nothing.
        Override for streaming support.

        Args:
            state: Current agent state

        Yields:
            Response chunks
        """
        # Default: no streaming, execute and yield final result
        result = await self.execute(state)
        if "messages" in result and result["messages"]:
            last_msg = result["messages"][-1]
            if hasattr(last_msg, "content"):
                yield str(last_msg.content)


class SkeletonAgent(BaseAgent):
    """
    Skeleton agent for Phase 3.

    Placeholder implementation that returns a simple message.
    Will be replaced with full implementations in Phase 4+.
    """

    def __init__(self, agent_name: str = "skeleton", agent_description: str = ""):
        """
        Initialize skeleton agent.

        Args:
            agent_name: Agent name
            agent_description: Agent description
        """
        self._name = agent_name
        self._description = agent_description or f"Skeleton agent: {agent_name}"

    @property
    def name(self) -> str:
        """Agent name."""
        return self._name

    @property
    def description(self) -> str:
        """Agent description."""
        return self._description

    async def execute(self, state: AgentState) -> dict[str, Any]:
        """
        Skeleton execution.

        Returns a placeholder response indicating the agent
        is not yet fully implemented.
        """
        logger.info("SkeletonAgent '%s' executing (Phase 3 placeholder)", self._name)

        from langchain_core.messages import AIMessage

        placeholder_response = (
            f"[Agent: {self._name}] This agent is a Phase 3 skeleton. "
            f"Full implementation coming in Phase 4+. "
            f"Input received: {state.get('input', '')[:100]}..."
        )

        return {
            "messages": [AIMessage(content=placeholder_response)],
            "agent_outcome": placeholder_response,
        }

    async def stream(self, state: AgentState) -> AsyncIterator[str]:
        """Stream skeleton response."""
        result = await self.execute(state)
        if "agent_outcome" in result:
            yield str(result["agent_outcome"])


# Pre-defined skeleton agents for Phase 3
coding_agent = SkeletonAgent(
    agent_name="coding",
    agent_description="Handles code-related tasks (skeleton)",
)

research_agent = SkeletonAgent(
    agent_name="research",
    agent_description="Handles research and analysis tasks (skeleton)",
)
