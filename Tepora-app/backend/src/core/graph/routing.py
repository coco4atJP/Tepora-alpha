"""
Graph routing logic.

This module provides routing functions that determine
which path the graph should take based on state.
"""

from __future__ import annotations

import logging
import re
from typing import Literal

from langchain_core.messages import AIMessage

from .constants import GraphRoutes, InputMode
from .state import AgentState

logger = logging.getLogger(__name__)


ROUTING_TAG_MAP: dict[str, str] = {
    "planning": "high",
    "high": "high",
    "fast": "fast",
    "direct": "direct",  # Agent mode direct
    "chat": "chat",      # Chat mode
}

def extract_routing_tag(user_input: str) -> tuple[str, str | None]:
    """
    Extract routing tag from user input.

    Supported tags:
      <planning>...</planning> -> high
      <high>...</high> -> high
      <fast>...</fast> -> fast
      <direct>...</direct> -> direct (agent mode)
      <chat>...</chat> -> chat

    Returns:
        (cleaned_input, agent_mode_hint)
    """
    cleaned = user_input

    for tag, mode in ROUTING_TAG_MAP.items():
        open_tag = re.compile(rf"<{tag}>", re.IGNORECASE)
        close_tag = re.compile(rf"</{tag}>", re.IGNORECASE)
        if open_tag.search(cleaned) and close_tag.search(cleaned):
            cleaned = open_tag.sub("", cleaned)
            cleaned = close_tag.sub("", cleaned)
            return cleaned.strip(), mode

    return cleaned, None


def route_by_command(
    state: AgentState,
) -> str:
    """
    Determine route based on user input command.

    Args:
        state: Current agent state

    Returns:
        Route identifier string
    """
    mode = state.get("mode")
    logger.info("Routing decision for mode: '%s'", mode)

    if mode == InputMode.AGENT:
        logger.info("Route: agent_mode (ReAct loop)")
        return GraphRoutes.AGENT_MODE
    elif mode == InputMode.SEARCH:
        logger.info("Route: search")
        return GraphRoutes.SEARCH
    elif mode == InputMode.STATS:
        logger.info("Route: stats (EM diagnostics)")
        return GraphRoutes.STATS
    else:
        # Fallback to direct answer (chat)
        logger.info("Route: direct_answer (chat)")
        return GraphRoutes.DIRECT_ANSWER


def should_continue_react_loop(state: AgentState) -> Literal["continue", "end"]:
    """
    Determine if ReAct loop should continue based on tool calls or finish action.

    Args:
        state: Current agent state

    Returns:
        "continue" if loop should continue, "end" if it should terminate
    """
    logger.debug("Decision: Should Continue ReAct Loop?")

    if "agent_outcome" in state and state["agent_outcome"]:
        logger.info("Decision: End ReAct loop (finish action detected).")
        logger.debug("Final outcome: %s", state["agent_outcome"])
        return "end"

    # If last message in scratchpad has tool calls, continue
    if state["agent_scratchpad"]:
        last_message = state["agent_scratchpad"][-1]
        logger.debug("Last message in scratchpad: %s", type(last_message).__name__)

        if isinstance(last_message, AIMessage) and last_message.tool_calls:
            logger.info("Decision: Continue ReAct loop (last message has tool calls).")
            logger.debug("Tool calls: %s", [tc["name"] for tc in last_message.tool_calls])
            return "continue"
        else:
            logger.info("Decision: End ReAct loop (last message has no tool calls).")
            if isinstance(last_message, AIMessage):
                logger.debug("Last message content: %s...", last_message.content[:100])
            return "end"
    else:
        logger.info("Decision: End ReAct loop (empty scratchpad).")
        return "end"


def route_from_supervisor(state: AgentState) -> str:
    """
    Determine route from Supervisor node.

    Returns:
        "planner" or the selected agent_id.
    """
    route = state.get("supervisor_route")
    if route == "planner":
        return "planner"

    selected_agent = state.get("selected_agent_id")
    if selected_agent:
        return selected_agent

    # Fallback to planner if no agent selected
    return "planner"
