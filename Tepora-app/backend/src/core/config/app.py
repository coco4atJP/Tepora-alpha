"""
Application-level configuration and constants.

This module provides general application settings by loading them
from the central `config.yml` file.
"""

from .loader import settings

# Input validation
MAX_INPUT_LENGTH = settings.app.max_input_length

# User command prefixes
CMD_AGENT_MODE = "/agentmode"
CMD_SEARCH = "/search"
CMD_EM_STATS = "/emstats"
CMD_EM_STATS_PROF = "/emstats_prof"

# Prompt injection patterns to detect
DANGEROUS_PATTERNS = settings.app.dangerous_patterns

# Graph execution settings
GRAPH_RECURSION_LIMIT = settings.app.graph_recursion_limit

# Streaming event types
STREAM_EVENT_CHAT_MODEL = "on_chat_model_stream"
STREAM_EVENT_GRAPH_END = "on_graph_end"

# Search Attachment Limits
SEARCH_ATTACHMENT_SIZE_LIMIT = 512 * 1024  # 512 KiB
SEARCH_ATTACHMENT_CHAR_LIMIT = 6000
