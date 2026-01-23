"""
Application State Management

Provides centralized state management for the Tepora web server.
Supports both global access (legacy) and dependency injection patterns.

Phase 4: V1/V2 Switch via TEPORA_USE_V2 environment variable.
"""

import logging
import os

from fastapi import Request, WebSocket

from src.core.app.core import TeporaCoreApp
from src.core.app_v2 import TeporaApp as TeporaAppV2
from src.core.config.loader import PROJECT_ROOT
from src.core.mcp.hub import McpHub
from src.core.mcp.registry import McpRegistry

logger = logging.getLogger(__name__)


class AppState:
    """
    Centralized application state container.

    Manages the lifecycle of the core application instance
    and MCP infrastructure.

    Phase 4: Supports V1 (TeporaCoreApp) and V2 (TeporaApp) via
    TEPORA_USE_V2 environment variable.
    """

    def __init__(self):
        self._core: TeporaCoreApp | None = None
        self._core_v2: TeporaAppV2 | None = None
        self._use_v2 = os.getenv("TEPORA_USE_V2", "false").lower() == "true"
        self._download_manager = None
        self._mcp_hub = None
        self._mcp_registry = None
        self._mcp_policy_manager = None

        if self._use_v2:
            logger.info("V2 mode enabled (TEPORA_USE_V2=true)")

    @property
    def use_v2(self) -> bool:
        """Check if V2 mode is enabled."""
        return self._use_v2

    @property
    def download_manager(self):
        """Get or create DownloadManager instance (shared across API and LLMManager)."""
        if self._download_manager is None:
            from src.core.download import DownloadManager

            self._download_manager = DownloadManager()
        return self._download_manager

    @property
    def core(self) -> TeporaCoreApp:
        """Get or create the TeporaCoreApp instance (V1)."""
        if self._core is None:
            self._core = TeporaCoreApp()
        return self._core

    @core.setter
    def core(self, value: TeporaCoreApp) -> None:
        """Set the TeporaCoreApp instance (for testing/mocking)."""
        self._core = value

    @property
    def core_v2(self) -> TeporaAppV2:
        """Get or create the TeporaApp instance (V2)."""
        if self._core_v2 is None:
            self._core_v2 = TeporaAppV2()
        return self._core_v2

    @core_v2.setter
    def core_v2(self, value: TeporaAppV2) -> None:
        """Set the TeporaApp instance (for testing/mocking)."""
        self._core_v2 = value

    @property
    def active_core(self):
        """Get the active core instance (V1 or V2 based on TEPORA_USE_V2)."""
        return self.core_v2 if self._use_v2 else self.core

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

    async def initialize(self) -> bool:
        """Initialize the core app and MCP infrastructure."""
        # Initialize MCP Hub first so the core ToolManager can reuse it (no duplicate connections).
        try:
            await self._initialize_mcp()
        except Exception as e:
            logger.error("Failed to initialize MCP Hub: %s", e, exc_info=True)
            # Don't fail initialization - MCP is optional

        # Initialize the appropriate core app
        if self._use_v2:
            logger.info("Initializing V2 core (TeporaApp)...")
            return await self.core_v2.initialize(
                mcp_hub=self._mcp_hub,
                download_manager=self.download_manager,
            )
        else:
            logger.info("Initializing V1 core (TeporaCoreApp)...")
            return await self.core.initialize(
                mcp_hub=self._mcp_hub,
                download_manager=self.download_manager,
            )

    async def _initialize_mcp(self) -> None:
        """Initialize MCP Hub and Registry."""
        # Determine config paths
        config_path = PROJECT_ROOT / "config" / "mcp_tools_config.json"
        policy_path = PROJECT_ROOT / "config" / "mcp_policy.json"

        # Initialize Registry
        # Prefer the local registry seed (if present in project reference materials),
        # otherwise fall back to the bundled seed.json.
        repo_root = PROJECT_ROOT.parents[1]  # backend -> Tepora-app -> Tepora_Project
        local_seed = (
            repo_root
            / "プロジェクト参考資料"
            / "MCP関連"
            / "registry-main"
            / "registry-main"
            / "data"
            / "seed.json"
        )
        self._mcp_registry = McpRegistry(seed_path=local_seed if local_seed.exists() else None)
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
        if self._use_v2 and self._core_v2:
            try:
                await self._core_v2.cleanup()
                logger.info("V2 Core app cleanup completed")
            except Exception as e:
                logger.warning("Error during V2 core cleanup: %s", e, exc_info=True)
        elif self._core:
            try:
                await self._core.cleanup()
                logger.info("V1 Core app cleanup completed")
            except Exception as e:
                logger.warning("Error during V1 core cleanup: %s", e, exc_info=True)

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
