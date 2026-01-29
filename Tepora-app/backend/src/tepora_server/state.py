"""
Application State Management

Provides centralized state management for the Tepora web server.
Supports dependency injection patterns.

V2-only runtime:
- V1 execution paths are removed.
"""

import asyncio
import logging
from typing import Any

from fastapi import Request, WebSocket

from src.core.app_v2 import TeporaApp
from src.core.mcp.hub import McpHub
from src.core.mcp.paths import (
    ensure_mcp_config_exists,
    resolve_mcp_config_path,
    resolve_mcp_policy_path,
)
from src.core.mcp.registry import McpRegistry

logger = logging.getLogger(__name__)


class AppState:
    """
    Centralized application state container.

    Manages the lifecycle of the core application instance
    and MCP infrastructure.
    """

    def __init__(self):
        self._core: TeporaApp | None = None
        self._download_manager: Any | None = None
        self._mcp_hub: McpHub | None = None
        self._mcp_registry: McpRegistry | None = None
        self._mcp_policy_manager: Any | None = None
        self._mcp_init_error: str | None = None

    @property
    def download_manager(self):
        """Get or create DownloadManager instance (shared across API and LLMManager)."""
        if self._download_manager is None:
            from src.core.download import DownloadManager

            self._download_manager = DownloadManager()
        return self._download_manager

    @property
    def core(self) -> TeporaApp:
        """Get or create the TeporaApp instance (V2)."""
        if self._core is None:
            self._core = TeporaApp()
        return self._core

    @core.setter
    def core(self, value: TeporaApp) -> None:
        """Set the TeporaApp instance (for testing/mocking)."""
        self._core = value

    @property
    def active_core(self):
        """Get the active core instance (V2-only)."""
        return self.core

    @property
    def mcp_hub(self):
        """Get McpHub instance (may be None if not initialized)."""
        return self._mcp_hub

    @property
    def mcp_registry(self):
        """Get McpRegistry instance (may be None if not initialized)."""
        return self._mcp_registry

    @property
    def mcp_policy_manager(self):
        """Get McpPolicyManager instance (may be None if not initialized)."""
        return self._mcp_policy_manager

    @property
    def mcp_init_error(self) -> str | None:
        """Get the last MCP initialization error (if any)."""
        return self._mcp_init_error

    async def initialize(self) -> bool:
        """Initialize the core app and MCP infrastructure."""
        # Initialize MCP Hub first so the core ToolManager can reuse it (no duplicate connections).
        try:
            await self._initialize_mcp()
            self._mcp_init_error = None
        except Exception as e:
            self._mcp_init_error = f"{type(e).__name__}: {e}"
            logger.error("Failed to initialize MCP Hub: %s", e, exc_info=True)
            # Don't fail initialization - MCP is optional

        logger.info("Initializing core (V2-only, TeporaApp)...")
        asyncio.create_task(self._sync_ollama_safely())

        return await self.core.initialize(
            mcp_hub=self._mcp_hub,
            download_manager=self.download_manager,
        )

    async def _sync_ollama_safely(self):
        """Helper to sync ollama models without crashing startup."""
        try:
            logger.info("Starting background Ollama model sync...")
            await self.download_manager.model_manager.sync_ollama_models()
        except Exception as e:
            logger.warning("Background Ollama sync failed: %s", e)

    async def _initialize_mcp(self) -> None:
        """Initialize MCP Hub and Registry."""
        # Determine config paths
        config_path = resolve_mcp_config_path()
        ensure_mcp_config_exists(config_path)
        policy_path = resolve_mcp_policy_path(config_path=config_path)

        # Initialize Registry
        self._mcp_registry = McpRegistry()
        logger.info("MCP Registry initialized")

        # Initialize Policy Manager (Phase 4)
        from src.core.mcp.mcp_policy import McpPolicyManager

        self._mcp_policy_manager = McpPolicyManager(policy_path)
        logger.info("MCP Policy Manager initialized")

        # Initialize Hub (Phase 3)
        self._mcp_hub = McpHub(config_path, self._mcp_policy_manager)
        await self._mcp_hub.initialize()

        # Start config watcher for hot-reload
        self._mcp_hub.start_config_watcher()
        logger.info("MCP Hub initialized with config watcher")

    async def shutdown(self) -> None:
        """Shutdown all managed resources."""
        # Clean up core app resources first (LLM processes, tools, memory)
        if self._core:
            try:
                await self._core.cleanup()
                logger.info("Core app cleanup completed")
            except Exception as e:
                logger.warning("Error during core cleanup: %s", e, exc_info=True)

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
    state: AppState = request.app.state.app_state
    return state


def get_app_state_from_websocket(websocket: WebSocket) -> AppState:
    """
    Get AppState for WebSocket endpoints.

    Args:
        websocket: The FastAPI WebSocket object.

    Returns:
        The AppState instance attached to the app.
    """
    state: AppState = websocket.app.state.app_state
    return state
