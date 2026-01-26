"""
Thinking Node - Chain of Thought (CoT) Generation

Generates a thought process before the final answer if enabled.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage
from langchain_core.prompts import ChatPromptTemplate

from ..state import AgentState

if TYPE_CHECKING:
    from src.core.llm import LLMService

logger = logging.getLogger(__name__)


class ThinkingNode:
    """
    Thinking node for CoT generation.
    """

    def __init__(self, llm_service: LLMService):
        """
        Initialize thinking node.

        Args:
            llm_service: LLM service
        """
        self.llm_service = llm_service

    async def thinking_node(self, state: AgentState) -> dict[str, Any]:
        """
        Generate thought process.

        Args:
            state: Current agent state

        Returns:
            Updated thought_process or empty dict if disabled.
        """
        if not state.get("thinking_mode"):
            return {}

        logger.info("--- Node: Thinking (CoT) ---")

        client = await self.llm_service.get_client("character")

        # Simple prompt for thinking
        system_prompt = (
            "You are a deep thinking AI. "
            "Think step-by-step about the user's request before answering. "
            "Identify the core problem, consider multiple approaches, and plan your response. "
            "Output ONLY your thought process."
        )

        prompt = ChatPromptTemplate.from_messages(
            [
                ("system", system_prompt),
                ("human", "{input}"),
            ]
        )

        chain = prompt | client
        response = await chain.ainvoke({"input": state["input"]})

        thought = response.content if isinstance(response, AIMessage) else str(response)

        logger.info("Generated thought process: %s...", thought[:100])

        return {"thought_process": thought}
