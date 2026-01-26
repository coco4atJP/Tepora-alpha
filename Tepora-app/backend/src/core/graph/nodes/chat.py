"""
Chat Node - Direct Answer Generation

Handles direct chat responses with context window management.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate

from ..constants import ATTENTION_SINK_PREFIX, MemoryLimits
from ..state import AgentState

if TYPE_CHECKING:
    from src.core.context import ContextWindowManager
    from src.core.llm import LLMService

logger = logging.getLogger(__name__)


class ChatNode:
    """
    Chat node for direct answer generation.

    Implements hierarchical context structure:
    1. Attention Sink (fixed prefix)
    2. System/Persona Context
    3. Retrieved Memory (long-term)
    4. Local Context (short-term)
    """

    def __init__(
        self,
        llm_service: LLMService,
        context_manager: ContextWindowManager,
    ):
        """
        Initialize chat node.

        Args:
            llm_service: LLM service for model access
            context_manager: Context window manager
        """
        self.llm_service = llm_service
        self.context_manager = context_manager

    async def direct_answer_node(
        self,
        state: AgentState,
        *,
        persona: str = "",
        system_prompt: str = "",
    ) -> dict[str, Any]:
        """
        Generate direct answer with streaming.

        Args:
            state: Current agent state
            persona: Persona prompt
            system_prompt: System prompt

        Returns:
            Updated chat_history and generation_logprobs
        """
        logger.info("--- Node: Direct Answer (V2 Streaming) ---")

        # Get character model
        client = await self.llm_service.get_client("character")

        # Build hierarchical context
        full_history = state.get("chat_history", [])
        retrieved_memory_str = str(state.get("synthesized_memory") or "No relevant memories found.")
        thought_process = state.get("thought_process")

        # Build unified system message
        system_content_parts = [
            ATTENTION_SINK_PREFIX,
            "",
            persona,
            "",
            system_prompt,
            "",
            "<retrieved_memory>",
            retrieved_memory_str,
            "</retrieved_memory>",
        ]

        if thought_process:
            system_content_parts.extend(
                [
                    "",
                    "<thought_process>",
                    thought_process,
                    "</thought_process>",
                ]
            )

        # Build local context
        max_local_tokens = MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS

        async def token_counter(msgs: list) -> int:
            # Use LLMService token counting if available
            if hasattr(self.llm_service, "count_tokens"):
                return await self.llm_service.count_tokens(msgs)
            # Fallback to estimation
            return sum(len(str(m.content)) // 4 for m in msgs)

        local_context, current_tokens = await self.context_manager.build_local_context(
            full_history,
            max_tokens=max_local_tokens,
            token_counter=token_counter,
        )

        # Add omission notice if history was trimmed
        if len(local_context) != len(full_history):
            system_content_parts.extend(
                [
                    "",
                    "... (earlier conversation omitted; rely on long-term memories) ...",
                    "--- Recent conversation context ---",
                ]
            )
            logger.info(
                "Context: %d messages (~%d tokens), omitted %d messages",
                len(local_context),
                current_tokens,
                len(full_history) - len(local_context),
            )

        # Create unified system message
        unified_system = SystemMessage(content="\n".join(system_content_parts))
        context_messages = [unified_system] + local_context

        # Build prompt
        prompt = ChatPromptTemplate.from_messages(
            [
                ("placeholder", "{context_history}"),
                ("human", "<user_input>{input}</user_input>"),
            ]
        )

        chain = prompt | client

        # Stream response
        full_response = ""
        logprobs = None

        async for chunk in chain.astream(
            {
                "context_history": context_messages,
                "input": state["input"],
            },
            config={"configurable": {"model_kwargs": {"logprobs": True}}},
        ):
            if hasattr(chunk, "content") and chunk.content:
                full_response += chunk.content
            if hasattr(chunk, "response_metadata") and chunk.response_metadata:
                chunk_logprobs = chunk.response_metadata.get("logprobs")
                if chunk_logprobs:
                    logprobs = chunk_logprobs

        return {
            "chat_history": state["chat_history"]
            + [
                HumanMessage(content=state["input"]),
                AIMessage(content=full_response),
            ],
            "generation_logprobs": logprobs,
        }

    async def stream_direct_answer(
        self,
        state: AgentState,
        *,
        persona: str = "",
        system_prompt: str = "",
    ) -> AsyncIterator[str]:
        """
        Stream direct answer chunks.

        Yields:
            Response text chunks
        """
        client = await self.llm_service.get_client("character")

        full_history = state.get("chat_history", [])
        retrieved_memory = str(state.get("synthesized_memory") or "No relevant memories found.")
        thought_process = state.get("thought_process")

        system_parts = [
            ATTENTION_SINK_PREFIX,
            "",
            persona,
            "",
            system_prompt,
            "",
            "<retrieved_memory>",
            retrieved_memory,
            "</retrieved_memory>",
        ]

        if thought_process:
            system_parts.extend(
                [
                    "",
                    "<thought_process>",
                    thought_process,
                    "</thought_process>",
                ]
            )

        local_context, _ = await self.context_manager.build_local_context(
            full_history,
            max_tokens=MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS,
        )

        unified_system = SystemMessage(content="\n".join(system_parts))
        context_messages = [unified_system] + local_context

        prompt = ChatPromptTemplate.from_messages(
            [
                ("placeholder", "{context_history}"),
                ("human", "<user_input>{input}</user_input>"),
            ]
        )

        chain = prompt | client

        async for chunk in chain.astream(
            {
                "context_history": context_messages,
                "input": state["input"],
            }
        ):
            if hasattr(chunk, "content") and chunk.content:
                yield chunk.content
