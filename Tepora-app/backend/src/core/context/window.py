"""
Context Window Manager - Token-based Context Window Management

Manages the local context window for LLM interactions.
Decoupled from LLMManager to allow flexible token counting strategies.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.messages import BaseMessage

logger = logging.getLogger(__name__)


class ContextWindowManager:
    """
    Manages context window for LLM prompts.

    Responsible for trimming conversation history to fit within
    token limits while preserving recent context.

    Usage:
        manager = ContextWindowManager()

        # With a token counter function
        local_context, tokens = await manager.build_local_context(
            full_history=messages,
            max_tokens=2048,
            token_counter=llm_service.count_tokens,
        )
    """

    def __init__(self, default_max_tokens: int = 2048):
        """
        Initialize context window manager.

        Args:
            default_max_tokens: Default maximum tokens for context window
        """
        self.default_max_tokens = default_max_tokens

    async def build_local_context(
        self,
        full_history: list[BaseMessage],
        max_tokens: int | None = None,
        token_counter: Callable[[list[BaseMessage]], Awaitable[int]] | None = None,
    ) -> tuple[list[BaseMessage], int]:
        """
        Build local context from full history within token limits.

        Iterates through history in reverse order, adding messages
        until the token limit is reached.

        Args:
            full_history: Complete message history
            max_tokens: Maximum tokens allowed (uses default if None)
            token_counter: Async function to count tokens for messages.
                           If None, uses character-based estimation.

        Returns:
            Tuple of (trimmed messages, total token count)
        """
        if max_tokens is None:
            max_tokens = self.default_max_tokens

        if not full_history:
            return [], 0

        local_context: list[Any] = []
        current_tokens = 0

        for i in range(len(full_history) - 1, -1, -1):
            msg = full_history[i]

            # Count tokens for this message
            if token_counter is not None:
                try:
                    msg_tokens = await token_counter([msg])
                except Exception:
                    # Fallback to estimation if counter fails
                    msg_tokens = self._estimate_tokens(msg)
            else:
                msg_tokens = self._estimate_tokens(msg)

            # Stop if adding this message exceeds limit (but keep at least one)
            if current_tokens + msg_tokens > max_tokens and local_context:
                break

            local_context.insert(0, msg)
            current_tokens += msg_tokens

        if len(local_context) < len(full_history):
            logger.debug(
                "Context trimmed: %d -> %d messages (~%d tokens)",
                len(full_history),
                len(local_context),
                current_tokens,
            )

        return local_context, current_tokens

    def _estimate_tokens(self, message: BaseMessage) -> int:
        """
        Estimate token count based on character length.

        Uses a simple heuristic of ~4 characters per token.
        This is a fallback when no token counter is provided.

        Args:
            message: Message to estimate

        Returns:
            Estimated token count
        """
        content = message.content if isinstance(message.content, str) else str(message.content)
        # Rough estimation: 1 token ≈ 4 characters
        return max(1, len(content) // 4)

    def check_needs_trimming(
        self,
        history_length: int,
        estimated_tokens: int,
        max_tokens: int | None = None,
    ) -> bool:
        """
        Check if history needs trimming.

        Args:
            history_length: Number of messages in history
            estimated_tokens: Estimated total tokens
            max_tokens: Token limit to check against

        Returns:
            True if trimming is needed
        """
        if max_tokens is None:
            max_tokens = self.default_max_tokens

        return estimated_tokens > max_tokens
