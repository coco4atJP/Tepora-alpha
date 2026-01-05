"""
Application State Management

Provides centralized state management for the Tepora web server.
Supports both global access (legacy) and dependency injection patterns.
"""

import logging

from fastapi import Request, WebSocket

from src.core.app.core import TeporaCoreApp
from src.core.config.loader import PROJECT_ROOT
from src.core.mcp.hub import McpHub
from src.core.mcp.registry import McpRegistry

logger = logging.getLogger(__name__)


class AppState:
    """
    Centralized application state container.

    Manages the lifecycle of the core application instance
    and MCP infrastructure.
    """

    def __init__(self):
        self._core: TeporaCoreApp | None = None
        self._mcp_hub = None
        self._mcp_registry = None

    @property
    def core(self) -> TeporaCoreApp:
        """Get or create the TeporaCoreApp instance."""
        if self._core is None:
            self._core = TeporaCoreApp()
        return self._core

    @core.setter
    def core(self, value: TeporaCoreApp) -> None:
        """Set the TeporaCoreApp instance (for testing/mocking)."""
        self._core = value

    @property
    def mcp_hub(self):
        """Get McpHub instance (may be None if not initialized)."""
        return self._mcp_hub

    @property
    def mcp_registry(self):
        """Get McpRegistry instance (may be None if not initialized)."""
        return self._mcp_registry

    async def initialize(self) -> bool:
        """Initialize the core app and MCP infrastructure."""
        # Initialize core app
        result = await self.core.initialize()

        # Initialize MCP Hub
        try:
            await self._initialize_mcp()
        except Exception as e:
            logger.error("Failed to initialize MCP Hub: %s", e)
            # Don't fail initialization - MCP is optional

        return result

    async def _initialize_mcp(self) -> None:
        """Initialize MCP Hub and Registry."""
        # Determine config path
        config_path = PROJECT_ROOT / "config" / "mcp_tools_config.json"

        # Initialize Registry
        self._mcp_registry = McpRegistry()
        logger.info("MCP Registry initialized")

        # Initialize Hub
        self._mcp_hub = McpHub(config_path)
        await self._mcp_hub.initialize()

        # Start config watcher for hot-reload
        self._mcp_hub.start_config_watcher()
        logger.info("MCP Hub initialized with config watcher")

    async def shutdown(self) -> None:
        """Shutdown all managed resources."""
        if self._mcp_hub:
            await self._mcp_hub.shutdown()
        if self._mcp_registry:
            await self._mcp_registry.close()


# --- Dependency Injection Helpers ---


def get_app_state(request: Request) -> AppState:
    """
    Get the AppState instance from the request object.

    Args:
        request: The FastAPI request object.

    Returns:
        The AppState instance attached to the app.

    Raises:
        AttributeError: If app.state.app_state is not set.
    """
    return request.app.state.app_state


def get_app_state_from_websocket(websocket: WebSocket) -> AppState:
    """
    Get AppState for WebSocket endpoints.

    Args:
        websocket: The FastAPI WebSocket object.

    Returns:
        The AppState instance attached to the app.
    """
    return websocket.app.state.app_state
