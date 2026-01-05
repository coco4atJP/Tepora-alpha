"""
MCP (Model Context Protocol) Integration Package.

This package provides:
- McpHub: Central lifecycle management for MCP clients
- McpRegistry: Official MCP registry integration
- McpInstaller: Smart command generation and installation helpers
"""

from .hub import McpHub
from .installer import McpInstaller, extract_env_schema, generate_command
from .registry import McpRegistry

__all__ = [
    "McpHub",
    "McpRegistry",
    "McpInstaller",
    "generate_command",
    "extract_env_schema",
]
