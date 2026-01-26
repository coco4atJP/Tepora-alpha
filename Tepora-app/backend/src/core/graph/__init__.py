"""
Agent graph package.

This package provides a modular implementation of the agent's
execution graph using LangGraph.

Main components:
- TeporaGraph: Graph runtime (V2-only)
- Node implementations: Chat, Search, ReAct, EM-LLM
- Routing logic
- Constants and utilities

The legacy monolithic graph.py is replaced by this modular structure.
"""

from __future__ import annotations

from .constants import (
    ATTENTION_SINK_PREFIX,
    PROFESSIONAL_ATTENTION_SINK,
    GraphNodes,
    GraphRoutes,
    InputMode,
    MemoryLimits,
    RAGConfig,
)
from .routing import route_by_command, should_continue_react_loop
from .runtime import TeporaGraph
from .state import AgentState, create_initial_state
from .utils import (
    append_context_timestamp,
    clone_message_with_timestamp,
    format_episode_list,
    format_scratchpad,
    truncate_json_bytes,
)

# For backward compatibility with existing imports
__all__ = [
    # V2
    "TeporaGraph",
    "AgentState",
    "create_initial_state",
    # Shared
    "GraphNodes",
    "GraphRoutes",
    "InputMode",
    "MemoryLimits",
    "RAGConfig",
    "ATTENTION_SINK_PREFIX",
    "PROFESSIONAL_ATTENTION_SINK",
    "route_by_command",
    "should_continue_react_loop",
    "format_scratchpad",
    "append_context_timestamp",
    "clone_message_with_timestamp",
    "format_episode_list",
    "truncate_json_bytes",
]
