from __future__ import annotations

"""Utilities and tool definitions used by :mod:`agent_core`."""

from .native import (
    GoogleCustomSearchInput,
    GoogleCustomSearchTool,
    WebFetchInput,
    WebFetchTool,
    NativeToolProvider,
)
from .mcp import (
    load_connections_from_config,
    load_mcp_tools_robust,
    McpToolProvider,
)
from .base import ToolProvider

__all__ = [
    "ToolProvider",
    "GoogleCustomSearchInput",
    "GoogleCustomSearchTool",
    "WebFetchInput",
    "WebFetchTool",
    "NativeToolProvider",
    "McpToolProvider",
    "load_connections_from_config",
    "load_mcp_tools_robust",
]


