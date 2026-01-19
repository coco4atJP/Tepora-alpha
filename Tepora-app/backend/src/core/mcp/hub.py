"""
McpHub - Facade for MCP server management.

This is the main entry point for MCP functionality. It coordinates:
- McpConfigService for configuration management
- McpConnectionManager for connection lifecycle

The hub provides a unified interface while delegating actual work
to specialized services.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from langchain_core.tools import BaseTool

from .config_service import McpConfigService
from .connection_manager import McpConnectionManager
from .models import McpServerStatus, McpToolsConfig

if TYPE_CHECKING:
    from .mcp_policy import McpPolicyManager

logger = logging.getLogger(__name__)


class McpHub:
    """
    Central hub for managing MCP server connections.

    This is a facade that coordinates:
    - Configuration loading and watching via McpConfigService
    - Connection lifecycle via McpConnectionManager

    Features:
    - Loads server configurations from mcp_tools_config.json
    - Manages lifecycle of all MCP clients
    - Provides connection status for each server
    - Supports hot-reload of config file changes
    - Config trust verification and approval workflow
    """

    def __init__(
        self,
        config_path: Path,
        policy_manager: McpPolicyManager | None = None,
    ) -> None:
        """
        Initialize McpHub.

        Args:
            config_path: Path to mcp_tools_config.json
            policy_manager: Optional McpPolicyManager for enforcing connection policies.
        """
        self._config_service = McpConfigService(config_path)
        self._connection_manager = McpConnectionManager(policy_manager)
        self._config: McpToolsConfig = McpToolsConfig()
        self._initialized = False

    @property
    def config_path(self) -> Path:
        """Get the config file path."""
        return self._config_service.config_path

    @property
    def policy_manager(self) -> McpPolicyManager | None:
        """Get the policy manager instance."""
        return self._connection_manager.policy_manager

    @property
    def initialized(self) -> bool:
        """Check if hub is initialized."""
        return self._initialized

    async def initialize(self) -> None:
        """Initialize the hub and load all configured servers."""
        if self._initialized:
            logger.warning("McpHub already initialized")
            return

        logger.info("Initializing McpHub from %s", self.config_path)
        self._config = self._config_service.load()
        await self._connection_manager.connect_all(self._config.mcpServers)
        self._initialized = True
        logger.info(
            "McpHub initialized with %d servers",
            len(self._connection_manager.get_connection_status()),
        )

    async def shutdown(self) -> None:
        """Shutdown the hub and close all connections."""
        logger.info("Shutting down McpHub...")

        # Stop config watcher
        await self._config_service.stop_watcher()

        # Close all clients
        await self._connection_manager.disconnect_all()

        self._initialized = False
        logger.info("McpHub shutdown complete")

    async def reload_config(self) -> None:
        """Reload configuration and reconnect servers as needed."""
        logger.info("Reloading MCP configuration...")
        old_config = self._config
        self._config = self._config_service.load()

        # Find servers to add, remove, or update
        old_servers = set(old_config.mcpServers.keys())
        new_servers = set(self._config.mcpServers.keys())

        to_remove = old_servers - new_servers
        to_add = new_servers - old_servers
        to_check = old_servers & new_servers

        # Remove deleted servers
        for name in to_remove:
            await self._connection_manager.disconnect(name)

        # Add new servers
        for name in to_add:
            await self._connection_manager.connect(name, self._config.mcpServers[name])

        # Check for config changes in existing servers
        for name in to_check:
            old_cfg = old_config.mcpServers.get(name)
            new_cfg = self._config.mcpServers.get(name)
            if old_cfg and new_cfg:
                # Check if enabled state changed
                if old_cfg.enabled != new_cfg.enabled:
                    if new_cfg.enabled:
                        await self._connection_manager.connect(name, new_cfg)
                    else:
                        await self._connection_manager.disconnect(name)
                # Check if command/args/env changed
                elif (
                    old_cfg.command != new_cfg.command
                    or old_cfg.args != new_cfg.args
                    or old_cfg.env != new_cfg.env
                ):
                    await self._connection_manager.disconnect(name)
                    if new_cfg.enabled:
                        await self._connection_manager.connect(name, new_cfg)

        logger.info("Config reload complete")

    # --- Public API ---

    def get_all_tools(self) -> list[BaseTool]:
        """Get all tools from all connected servers."""
        return self._connection_manager.get_all_tools()

    def get_connection_status(self) -> dict[str, McpServerStatus]:
        """Get connection status for all configured servers."""
        return self._connection_manager.get_connection_status()

    def get_config(self) -> McpToolsConfig:
        """Get current configuration."""
        return self._config

    async def update_config(self, new_config: dict[str, Any]) -> tuple[bool, str | None]:
        """
        Update configuration and save to file.

        Args:
            new_config: New configuration data

        Returns:
            (success, error_message)
        """
        try:
            # Validate with lenient parsing
            _ = self._config_service.parse_lenient(new_config)

            # Write to file
            self._config_service.save(new_config)

            # Reload
            await self.reload_config()
            return True, None

        except Exception as e:
            logger.error("Failed to update config: %s", e, exc_info=True)
            return False, str(e)

    async def enable_server(self, server_name: str) -> bool:
        """Enable a server by name."""
        return await self._set_server_enabled(server_name, True)

    async def disable_server(self, server_name: str) -> bool:
        """Disable a server by name."""
        return await self._set_server_enabled(server_name, False)

    async def _set_server_enabled(self, server_name: str, enabled: bool) -> bool:
        """Set server enabled state."""
        if server_name not in self._config.mcpServers:
            logger.warning("Server '%s' not found in config", server_name)
            return False

        config = self._config.mcpServers[server_name]
        if config.enabled == enabled:
            return True

        raw_config = self._config_service.read_raw()
        if server_name in raw_config.get("mcpServers", {}):
            raw_config["mcpServers"][server_name]["enabled"] = enabled
            success, error = await self.update_config(raw_config)
            if not success:
                logger.error("Failed to update MCP config: %s", error)
                return False
        return True

    # --- Config Watching ---

    def start_config_watcher(self, poll_interval: float = 2.0) -> None:
        """
        Start watching config file for changes.

        Uses polling for cross-platform compatibility.
        """
        self._config_service.start_watcher(self.reload_config, poll_interval)

    # --- Trust Management (delegated to config service) ---

    def detect_config_changes(self) -> dict[str, Any] | None:
        """Detect if current config file differs from last trusted state."""
        return self._config_service.detect_changes(self._config)

    def hold_pending_change(self, change_id: str, change_data: dict[str, Any]) -> None:
        """Hold a config change in pending state until user approval."""
        self._config_service.hold_pending_change(change_id, change_data)

    def get_pending_changes(self) -> list[dict[str, Any]]:
        """Get all pending config changes awaiting approval."""
        return self._config_service.get_pending_changes()

    async def approve_pending_change(self, change_id: str) -> tuple[bool, str | None]:
        """
        Approve and apply a pending config change.

        Returns:
            (success, error_message)
        """
        change = self._config_service.approve_pending_change(change_id)
        if change is None:
            return False, f"Pending change '{change_id}' not found"

        pending_config = change.get("pending_config", {})
        return await self.update_config(pending_config)

    def reject_pending_change(self, change_id: str) -> bool:
        """Reject and discard a pending config change."""
        return self._config_service.reject_pending_change(change_id)

    def trust_current_config(self) -> None:
        """Mark current config as trusted."""
        self._config_service.trust_config()

    def is_config_trusted(self) -> bool:
        """Check if current config file is in trusted state."""
        return self._config_service.is_trusted()
