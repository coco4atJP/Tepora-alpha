"""
MCP (Model Context Protocol) Integration Package.

This package provides:
- McpHub: Central lifecycle management for MCP clients
- McpRegistry: Official MCP registry integration
- McpInstaller: Smart command generation and installation helpers
"""

from .hub import McpHub
from .registry import McpRegistry
from .installer import McpInstaller, generate_command, extract_env_schema

__all__ = [
    "McpHub",
    "McpRegistry",
    "McpInstaller",
    "generate_command",
    "extract_env_schema",
]
