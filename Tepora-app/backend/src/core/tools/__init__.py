from __future__ import annotations

"""Utilities and tool definitions used by :mod:`agent_core`."""

# V1/V2 shared base
from .base import ToolProvider  # noqa: E402

# V2 Tool Manager
from .manager import ToolManager  # noqa: E402

# V1 MCP tools
from .mcp import (  # noqa: E402
    McpToolProvider,
    load_connections_from_config,
    load_mcp_tools_robust,
)

# V1 native tools
from .native import (  # noqa: E402
    NativeToolProvider,
    WebFetchInput,
    WebFetchTool,
)

__all__ = [
    # Base
    "ToolProvider",
    # V2
    "ToolManager",
    # V1 native
    "WebFetchInput",
    "WebFetchTool",
    "NativeToolProvider",
    # V1 MCP
    "McpToolProvider",
    "load_connections_from_config",
    "load_mcp_tools_robust",
]
