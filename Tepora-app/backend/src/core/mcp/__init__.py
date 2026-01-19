"""
MCP (Model Context Protocol) Integration Package.

This package provides:
- McpHub: Central facade for MCP management
- McpConfigService: Configuration file management
- McpConnectionManager: Connection lifecycle management
- McpRegistry: Official MCP registry integration
- McpInstaller: Smart command generation and installation helpers
"""

from .config_service import McpConfigService
from .connection_manager import McpConnectionManager
from .hub import McpHub
from .installer import McpInstaller, extract_env_schema, generate_command
from .registry import McpRegistry

__all__ = [
    "McpHub",
    "McpConfigService",
    "McpConnectionManager",
    "McpRegistry",
    "McpInstaller",
    "generate_command",
    "extract_env_schema",
]
