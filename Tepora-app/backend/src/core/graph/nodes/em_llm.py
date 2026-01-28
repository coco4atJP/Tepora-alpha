"""
EM-LLM specific graph nodes.

This module provides nodes for EM-LLM integration:
- Memory retrieval using two-stage search
- Memory formation with surprise or semantic change
- Statistics display
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage

if TYPE_CHECKING:
    from ...em_llm import EMLLMIntegrator
    from ..state import AgentState

logger = logging.getLogger(__name__)


class EMMemoryNodes:
    """EM-LLM specific memory node implementations."""

    def __init__(
        self,
        char_em_llm_integrator: EMLLMIntegrator,
        prof_em_llm_integrator: EMLLMIntegrator | None = None,
    ):
        """
        Initialize EM-LLM memory nodes.

        Args:
            char_em_llm_integrator: EM-LLM integrator for character agent
            prof_em_llm_integrator: Optional EM-LLM integrator for professional agent
        """
        self.char_em_llm_integrator = char_em_llm_integrator
        self.prof_em_llm_integrator = prof_em_llm_integrator or char_em_llm_integrator

    def _get_active_integrator(self, state: AgentState) -> EMLLMIntegrator:
        """
        Get active EM-LLM integrator based on current execution mode.

        Args:
            state: Current agent state

        Returns:
            Appropriate EM-LLM integrator
        """
        user_input = state.get("input", "").strip().lower()
        # /emstats_prof command also uses professional mode
        if user_input.startswith("/agentmode") or user_input.startswith("/emstats_prof"):
            logger.info("Integrator: Professional Mode")
            return self.prof_em_llm_integrator
        else:
            logger.info("Integrator: Character Mode")
            return self.char_em_llm_integrator

    def em_memory_retrieval_node(self, state: AgentState) -> dict:
        """
        [EM-LLM Version] Two-stage retrieval of related episodic memories.

        Based on paper architecture, stores retrieved events in `synthesized_memory`
        key for direct use by subsequent nodes. Searches from appropriate memory
        based on mode.

        Args:
            state: Current agent state

        Returns:
            Dictionary with recalled_episodes and synthesized_memory
        """
        logger.info("Node: EM-LLM Memory Retrieval (Two-Stage)")

        try:
            # Execute EM-LLM two-stage retrieval
            active_integrator = self._get_active_integrator(state)
            recalled_events_dict = active_integrator.retrieve_relevant_memories_for_query(
                state["input"]
            )

            if recalled_events_dict:
                logger.info(
                    "EM-LLM retrieved %d relevant episodic events.", len(recalled_events_dict)
                )
                # Log statistics
                for i, event in enumerate(recalled_events_dict):
                    surprise_stats = event.get("surprise_stats", {})
                    logger.info(
                        "  Event %d: %s... (surprise: %.3f)",
                        i + 1,
                        event.get("content", "")[:50],
                        surprise_stats.get("mean_surprise", 0),
                    )

                # Format event list as string for downstream nodes
                formatted_memory = self._format_episodes_for_context(recalled_events_dict)

                return {
                    "recalled_episodes": recalled_events_dict,  # Keep for logging/debug
                    "synthesized_memory": formatted_memory,
                }
            else:
                logger.info("No relevant episodic memories found.")
                return {
                    "recalled_episodes": [],
                    "synthesized_memory": "No relevant episodic memories found.",
                }

        except Exception as e:
            # Catch-all for graph node to prevent entire graph from failing
            error_message = f"EM-LLM memory retrieval failed: {e}"
            logger.warning("Warning: %s", error_message)
            logger.error("%s", error_message, exc_info=True)
            return {
                "recalled_episodes": [],
                "synthesized_memory": "An error occurred during memory retrieval.",
            }

    def _format_episodes_for_context(self, episodes: list[dict]) -> str:
        """
        Format retrieved episodes as string for LLM context.

        Args:
            episodes: List of episode dictionaries

        Returns:
            Formatted string
        """
        if not episodes:
            return "No relevant episodic memories found."

        return "\n\n".join(
            [
                f"Recalled Event {i + 1} (Surprise Score: {ep.get('surprise_stats', {}).get('mean_surprise', 0):.3f}):\n"
                f"{ep.get('content', 'N/A')}"
                for i, ep in enumerate(episodes)
            ]
        )

    async def _form_memory_with_surprisal(
        self, logprobs: dict[str, Any], state: AgentState
    ) -> list[Any]:
        """
        Form memory based on surprisal (main method from paper).

        Args:
            logprobs: Logprobs dictionary from LLM
            state: Current agent state

        Returns:
            List of formed episodic events
        """
        logger.info(
            "  - Analyzing %d tokens using surprisal-based segmentation.",
            len(logprobs["content"]),
        )
        active_integrator = self._get_active_integrator(state)
        return await active_integrator.process_logprobs_for_memory(logprobs["content"])

    async def _form_memory_with_semantic_change(
        self, state: AgentState, ai_response: str
    ) -> list[Any]:
        """
        Form memory based on semantic change (fallback).

        Args:
            state: Current agent state
            ai_response: AI's response text

        Returns:
            List of formed episodic events
        """
        logger.warning(
            "  - Warning: Logprobs not available. Falling back to semantic change-based segmentation."
        )
        logger.info("  - Analyzing AI response for semantic change to form episodic memories.")
        logger.info("  - Target text (first 150 chars): %s...", ai_response[:150])
        active_integrator = self._get_active_integrator(state)
        return await active_integrator.process_conversation_turn_for_memory(
            state.get("input"), ai_response
        )

    def _log_formation_stats(self, formed_events: list[Any]):
        """
        Log statistics of formed events.

        Args:
            formed_events: List of formed episodic events
        """
        if not formed_events:
            logger.info("No episodic events were formed from this conversation turn.")
            return

        total_tokens = sum(len(getattr(event, "tokens", [])) for event in formed_events)

        # Safely calculate average surprise
        total_surprise = 0
        event_count_with_surprise = 0
        for event in formed_events:
            scores = getattr(event, "surprise_scores", [])
            if scores:
                total_surprise += sum(scores) / len(scores)
                event_count_with_surprise += 1

        avg_surprise = (
            total_surprise / event_count_with_surprise if event_count_with_surprise > 0 else 0
        )

        logger.info(
            "EM-LLM formed %d new episodic events from the AI response.", len(formed_events)
        )
        logger.info("  - Total tokens: %d", total_tokens)
        logger.info("  - Average surprise: %.3f", avg_surprise)

    async def em_memory_formation_node(self, state: AgentState) -> dict:
        """
        [EM-LLM Version] Memory formation from conversation (async).

        If logprobs are available from LLM, performs "surprise-based" memory
        formation (main approach from paper). Otherwise, falls back to
        "semantic change-based" memory formation.

        Args:
            state: Current agent state

        Returns:
            Empty dictionary (no state updates)
        """
        logger.info("Node: EM-LLM Memory Formation (Direct)")

        # Get necessary data from state
        logprobs = state.get("generation_logprobs")
        ai_response_message = next(
            (msg for msg in reversed(state.get("chat_history", [])) if isinstance(msg, AIMessage)),
            None,
        )
        raw_response = ai_response_message.content if ai_response_message else None
        ai_response: str | None
        if raw_response is None:
            ai_response = None
        elif isinstance(raw_response, str):
            ai_response = raw_response
        else:
            ai_response = json.dumps(raw_response, ensure_ascii=False)

        if not ai_response:
            logger.warning(
                "  - Warning: Could not find AI response. Skipping EM-LLM memory formation."
            )
            return {}

        logger.info("Starting EM-LLM memory formation...")
        formed_events = []
        try:
            # Check if logprobs available and call appropriate memory formation method
            if isinstance(logprobs, dict) and logprobs.get("content"):
                formed_events = await self._form_memory_with_surprisal(logprobs, state)
            else:
                formed_events = await self._form_memory_with_semantic_change(state, ai_response)

            # Log statistics of formed events
            self._log_formation_stats(formed_events)

        except Exception as e:
            error_message = f"EM-LLM memory formation error: {e}"
            logger.error("  - Error: %s", error_message)
            logger.error("%s", error_message, exc_info=True)

        logger.info("Memory formation completed. Graph continues.")
        return {}

    def em_stats_node(self, state: AgentState) -> dict:
        """
        Display EM-LLM system statistics (for debugging).

        Args:
            state: Current agent state

        Returns:
            Empty dictionary (no state updates)
        """
        logger.info("Node: EM-LLM Statistics")

        try:
            active_integrator = self._get_active_integrator(state)
            stats = active_integrator.get_memory_statistics()
            logger.info("EM-LLM Memory System Statistics:")
            logger.info("  Total Events: %d", stats.get("total_events", 0))
            if "total_tokens_in_memory" in stats:
                logger.info("  Total Tokens in Memory: %s", stats.get("total_tokens_in_memory"))
            if "mean_event_size" in stats:
                logger.info("  Mean Event Size: %s", stats.get("mean_event_size"))

            surprise_stats = stats.get("surprise_statistics")
            if isinstance(surprise_stats, dict) and surprise_stats:
                logger.info(
                    "  Surprise Stats - Mean: %.3f, Std: %.3f, Max: %.3f",
                    surprise_stats.get("mean", 0),
                    surprise_stats.get("std", 0),
                    surprise_stats.get("max", 0),
                )

            config_info = stats.get("configuration", {})
            logger.info(
                "  Configuration - Gamma: %s, Event Size: %s-%s",
                config_info.get("surprise_gamma", 0),
                config_info.get("min_event_size", 0),
                config_info.get("max_event_size", 0),
            )

        except Exception as e:
            logger.warning("Warning: Failed to retrieve EM-LLM statistics: %s", e)
            logger.warning("Could not get EM-LLM statistics: %s", e, exc_info=True)

        return {}
