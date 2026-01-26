"""
Constants for graph nodes and routes.
"""

from enum import Enum


class GraphNodes:
    """LangGraph node names."""

    MEMORY_RETRIEVAL = "memory_retrieval"
    SAVE_MEMORY = "save_memory"
    DIRECT_ANSWER = "direct_answer"
    GENERATE_SEARCH_QUERY = "generate_search_query"
    EXECUTE_SEARCH = "execute_search"
    SUMMARIZE_SEARCH_RESULT = "summarize_search_result"
    GENERATE_ORDER = "generate_order"
    AGENT_REASONING = "agent_reasoning"
    SYNTHESIZE_FINAL_RESPONSE = "synthesize_final_response"
    TOOL_NODE = "tool_node"
    UPDATE_SCRATCHPAD = "update_scratchpad"
    EM_MEMORY_RETRIEVAL = "em_memory_retrieval"
    EM_MEMORY_FORMATION = "em_memory_formation"
    EM_STATS = "em_stats_node"
    THINKING_NODE = "thinking"


class GraphRoutes:
    """LangGraph routing conditions."""

    AGENT_MODE = "agent_mode"
    SEARCH = "search"
    DIRECT_ANSWER = "direct_answer"
    STATS = "stats"


# Attention Sink Prefixes
# These are fixed prefixes to ensure the first few tokens (attention sinks) are consistent across conversations.
ATTENTION_SINK_PREFIX = "System: Initialize conversation."
PROFESSIONAL_ATTENTION_SINK = "System: Initialize professional agent."


class InputMode(str, Enum):
    """User-facing input modes."""

    DIRECT = "direct"
    SEARCH = "search"
    AGENT = "agent"
    STATS = "stats"


class MemoryLimits:
    """Memory limitation constants."""

    MAX_LOCAL_CONTEXT_TOKENS = 2048
    MAX_MEMORY_MESSAGES = 10
    MAX_MEMORY_JSON_BYTES = 10000


class RAGConfig:
    """RAG configuration constants."""

    CHUNK_SIZE = 500
    CHUNK_OVERLAP = 50
    EMBEDDING_BATCH_SIZE = 32
    TOP_K_CHUNKS = 5


# Tools that require confirmation before execution.
DANGEROUS_TOOLS = {"native_web_fetch", "native_google_search"}
