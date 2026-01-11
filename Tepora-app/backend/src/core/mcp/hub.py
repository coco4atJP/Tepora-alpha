"""
McpHub - Central lifecycle management for MCP clients.

Provides:
- Automatic loading of MCP servers from config file
- Config file watching and hot-reload
- Connection status tracking
- Lenient validation for third-party servers
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from .models import (
    ConnectionStatus,
    McpServerConfig,
    McpServerStatus,
    McpToolsConfig,
    TransportType,
)

if TYPE_CHECKING:
    from .mcp_policy import McpPolicyManager

logger = logging.getLogger(__name__)


class McpHub:
    """
    Central hub for managing MCP server connections.

    Features:
    - Loads server configurations from mcp_tools_config.json
    - Manages lifecycle of all MCP clients
    - Provides connection status for each server
    - Supports hot-reload of config file changes
    - Lenient validation to handle third-party server quirks
    - Phase 3: Config change detection & approval
    - Phase 4: Connection policy enforcement
    """

    def __init__(self, config_path: Path, policy_manager: McpPolicyManager | None = None):
        """
        Initialize McpHub.

        Args:
            config_path: Path to mcp_tools_config.json
            policy_manager: Optional McpPolicyManager for enforcing connection policies.
        """
        self.config_path = config_path
        self._policy_manager = policy_manager
        self._config: McpToolsConfig = McpToolsConfig()
        self._clients: dict[str, MultiServerMCPClient] = {}
        self._tools: dict[str, list[BaseTool]] = {}  # server_name -> tools
        self._status: dict[str, McpServerStatus] = {}
        self._initialized = False
        self._watcher_task: asyncio.Task | None = None
        self._last_config_mtime: float = 0

        # Phase 3: Pending changes and trust management
        self._pending_changes: dict[str, dict[str, Any]] = {}  # change_id -> change_data
        self._trusted_hashes: set[str] = set()  # SHA256 hashes of approved configs
        self._load_trusted_hashes()

    @property
    def policy_manager(self) -> McpPolicyManager | None:
        """Get the policy manager instance."""
        return self._policy_manager

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
        await self._load_config()
        await self._connect_all_servers()
        self._initialized = True
        logger.info("McpHub initialized with %d servers", len(self._clients))

    async def shutdown(self) -> None:
        """Shutdown the hub and close all connections."""
        logger.info("Shutting down McpHub...")

        # Stop config watcher
        if self._watcher_task:
            self._watcher_task.cancel()
            try:
                await self._watcher_task
            except asyncio.CancelledError:
                pass
            self._watcher_task = None

        # Close all clients
        self._clients.clear()
        self._tools.clear()
        self._status.clear()
        self._initialized = False
        logger.info("McpHub shutdown complete")

    async def reload_config(self) -> None:
        """Reload configuration and reconnect servers as needed."""
        logger.info("Reloading MCP configuration...")
        old_config = self._config
        await self._load_config()

        # Find servers to add, remove, or update
        old_servers = set(old_config.mcpServers.keys())
        new_servers = set(self._config.mcpServers.keys())

        to_remove = old_servers - new_servers
        to_add = new_servers - old_servers
        to_check = old_servers & new_servers

        # Remove deleted servers
        for name in to_remove:
            await self._disconnect_server(name)

        # Add new servers
        for name in to_add:
            await self._connect_server(name, self._config.mcpServers[name])

        # Check for config changes in existing servers
        for name in to_check:
            old_cfg = old_config.mcpServers.get(name)
            new_cfg = self._config.mcpServers.get(name)
            if old_cfg and new_cfg:
                # Check if enabled state changed
                if old_cfg.enabled != new_cfg.enabled:
                    if new_cfg.enabled:
                        await self._connect_server(name, new_cfg)
                    else:
                        await self._disconnect_server(name)
                # Check if command/args/env changed
                elif (
                    old_cfg.command != new_cfg.command
                    or old_cfg.args != new_cfg.args
                    or old_cfg.env != new_cfg.env
                ):
                    await self._disconnect_server(name)
                    if new_cfg.enabled:
                        await self._connect_server(name, new_cfg)

        logger.info("Config reload complete")

    def get_all_tools(self) -> list[BaseTool]:
        """Get all tools from all connected servers."""
        all_tools: list[BaseTool] = []
        for tools in self._tools.values():
            all_tools.extend(tools)
        return all_tools

    def get_connection_status(self) -> dict[str, McpServerStatus]:
        """Get connection status for all configured servers."""
        return self._status.copy()

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
            _ = self._parse_config_lenient(new_config)

            # Write to file
            self.config_path.write_text(
                json.dumps(new_config, indent=2, ensure_ascii=False), encoding="utf-8"
            )

            # Reload
            await self.reload_config()
            return True, None

        except Exception as e:
            logger.error("Failed to update config: %s", e)
            return False, str(e)

    async def enable_server(self, server_name: str) -> bool:
        """Enable a server by name."""
        if server_name not in self._config.mcpServers:
            logger.warning("Server '%s' not found in config", server_name)
            return False

        config = self._config.mcpServers[server_name]
        if config.enabled:
            return True  # Already enabled

        # Update config
        raw_config = self._read_config_raw()
        if server_name in raw_config.get("mcpServers", {}):
            raw_config["mcpServers"][server_name]["enabled"] = True
            await self.update_config(raw_config)
        return True

    async def disable_server(self, server_name: str) -> bool:
        """Disable a server by name."""
        if server_name not in self._config.mcpServers:
            logger.warning("Server '%s' not found in config", server_name)
            return False

        config = self._config.mcpServers[server_name]
        if not config.enabled:
            return True  # Already disabled

        # Update config
        raw_config = self._read_config_raw()
        if server_name in raw_config.get("mcpServers", {}):
            raw_config["mcpServers"][server_name]["enabled"] = False
            await self.update_config(raw_config)
        return True

    def start_config_watcher(self, poll_interval: float = 2.0) -> None:
        """
        Start watching config file for changes.

        Uses polling instead of watchdog for cross-platform compatibility
        and simpler setup.
        """
        if self._watcher_task:
            logger.warning("Config watcher already running")
            return

        async def watch_loop():
            while True:
                try:
                    await asyncio.sleep(poll_interval)
                    if self.config_path.exists():
                        mtime = self.config_path.stat().st_mtime
                        if mtime > self._last_config_mtime:
                            logger.info("Config file changed, reloading...")
                            self._last_config_mtime = mtime
                            await self.reload_config()
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error("Error in config watcher: %s", e)

        self._watcher_task = asyncio.create_task(watch_loop())
        logger.info("Started config file watcher (poll interval: %ss)", poll_interval)

    # --- Pending Changes Management (Phase 3) ---

    def detect_config_changes(self) -> dict[str, Any] | None:
        """
        Detect if current config file differs from last trusted state.

        Returns:
            Change details if untrusted changes detected, None if config is trusted.
        """
        raw_config = self._read_config_raw()
        config_hash = self._compute_config_hash(raw_config)

        if config_hash in self._trusted_hashes:
            return None

        # Detect specific changes
        old_servers = set(self._config.mcpServers.keys())
        new_config = self._parse_config_lenient(raw_config)
        new_servers = set(new_config.mcpServers.keys())

        added = new_servers - old_servers
        removed = old_servers - new_servers
        modified = []

        for name in old_servers & new_servers:
            old_cfg = self._config.mcpServers[name]
            new_cfg = new_config.mcpServers.get(name)
            if new_cfg and (
                old_cfg.command != new_cfg.command
                or old_cfg.args != new_cfg.args
                or old_cfg.env != new_cfg.env
            ):
                modified.append(name)

        if not added and not removed and not modified:
            # No meaningful changes
            self._trusted_hashes.add(config_hash)
            self._save_trusted_hashes()
            return None

        return {
            "config_hash": config_hash,
            "added_servers": list(added),
            "removed_servers": list(removed),
            "modified_servers": modified,
            "pending_config": raw_config,
        }

    def hold_pending_change(self, change_id: str, change_data: dict[str, Any]) -> None:
        """Hold a config change in pending state until user approval."""
        self._pending_changes[change_id] = {
            **change_data,
            "created_at": datetime.now().isoformat(),
        }
        logger.info("Holding pending config change: %s", change_id)

    def get_pending_changes(self) -> list[dict[str, Any]]:
        """Get all pending config changes awaiting approval."""
        return [{"change_id": cid, **data} for cid, data in self._pending_changes.items()]

    async def approve_pending_change(self, change_id: str) -> tuple[bool, str | None]:
        """
        Approve and apply a pending config change.

        Returns:
            (success, error_message)
        """
        if change_id not in self._pending_changes:
            return False, f"Pending change '{change_id}' not found"

        change = self._pending_changes[change_id]
        pending_config = change.get("pending_config", {})
        config_hash = change.get("config_hash")

        # Apply the change
        success, error = await self.update_config(pending_config)

        if success:
            # Mark as trusted
            if config_hash:
                self._trusted_hashes.add(config_hash)
                self._save_trusted_hashes()
            del self._pending_changes[change_id]
            logger.info("Approved and applied pending change: %s", change_id)

        return success, error

    def reject_pending_change(self, change_id: str) -> bool:
        """Reject and discard a pending config change."""
        if change_id not in self._pending_changes:
            return False

        del self._pending_changes[change_id]
        logger.info("Rejected pending change: %s", change_id)
        return True

    def trust_current_config(self) -> None:
        """Mark current config as trusted."""
        raw_config = self._read_config_raw()
        config_hash = self._compute_config_hash(raw_config)
        self._trusted_hashes.add(config_hash)
        self._save_trusted_hashes()
        logger.info("Current config marked as trusted")

    def is_config_trusted(self) -> bool:
        """Check if current config file is in trusted state."""
        raw_config = self._read_config_raw()
        config_hash = self._compute_config_hash(raw_config)
        return config_hash in self._trusted_hashes

    def _compute_config_hash(self, config: dict[str, Any]) -> str:
        """Compute SHA256 hash of config for trust verification."""
        config_str = json.dumps(config, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(config_str.encode()).hexdigest()

    def _load_trusted_hashes(self) -> None:
        """Load trusted config hashes from storage."""
        trust_file = self.config_path.parent / ".mcp_trusted_hashes"
        try:
            if trust_file.exists():
                data = json.loads(trust_file.read_text(encoding="utf-8"))
                self._trusted_hashes = set(data.get("hashes", []))
                logger.debug("Loaded %d trusted hashes", len(self._trusted_hashes))
        except Exception as e:
            logger.warning("Failed to load trusted hashes: %s", e)
            self._trusted_hashes = set()

    def _save_trusted_hashes(self) -> None:
        """Save trusted config hashes to storage."""
        trust_file = self.config_path.parent / ".mcp_trusted_hashes"
        try:
            trust_file.write_text(
                json.dumps({"hashes": list(self._trusted_hashes)}, indent=2), encoding="utf-8"
            )
        except Exception as e:
            logger.warning("Failed to save trusted hashes: %s", e)

    # --- Private Methods ---

    async def _load_config(self) -> None:
        """Load configuration from file."""
        raw_config = self._read_config_raw()
        self._config = self._parse_config_lenient(raw_config)
        if self.config_path.exists():
            self._last_config_mtime = self.config_path.stat().st_mtime

    def _read_config_raw(self) -> dict[str, Any]:
        """Read raw config from file."""
        try:
            if not self.config_path.exists():
                logger.warning("Config file not found: %s", self.config_path)
                return {"mcpServers": {}}
            return json.loads(self.config_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error("Failed to read config file: %s", e)
            return {"mcpServers": {}}

    def _parse_config_lenient(self, raw_config: dict[str, Any]) -> McpToolsConfig:
        """
        Parse config with lenient validation.
        Handles missing optional fields and unknown fields gracefully.
        """
        servers: dict[str, McpServerConfig] = {}

        for name, server_data in raw_config.get("mcpServers", {}).items():
            try:
                # Handle legacy format (no 'enabled' field)
                if "enabled" not in server_data:
                    server_data["enabled"] = True

                # Skip empty or invalid entries
                if not server_data.get("command"):
                    logger.warning("Skipping server '%s': missing 'command'", name)
                    continue

                servers[name] = McpServerConfig.model_validate(server_data)
            except Exception as e:
                logger.warning("Lenient parse: skipping server '%s' due to: %s", name, e)
                # Still try to create a minimal config
                try:
                    servers[name] = McpServerConfig(
                        command=server_data.get("command", ""),
                        args=server_data.get("args", []),
                        env=server_data.get("env", {}),
                        enabled=server_data.get("enabled", True),
                    )
                except Exception:
                    pass

        return McpToolsConfig(mcpServers=servers)

    async def _connect_all_servers(self) -> None:
        """Connect to all enabled servers."""
        for name, config in self._config.mcpServers.items():
            if config.enabled:
                await self._connect_server(name, config)
            else:
                self._status[name] = McpServerStatus(
                    name=name,
                    status=ConnectionStatus.DISCONNECTED,
                    tools_count=0,
                )

    async def _connect_server(
        self, name: str, config: McpServerConfig, max_retries: int = 3
    ) -> bool:
        """
        Connect to a single MCP server.

        Returns True if connection successful.
        """
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.CONNECTING,
        )

        # Helper to mark error
        def _mark_error(err_msg: str):
            self._status[name] = McpServerStatus(
                name=name,
                status=ConnectionStatus.ERROR,
                error_message=err_msg,
            )
            logger.error(err_msg)

        # Phase 4: Check if connection is allowed by policy
        if self._policy_manager:
            is_local = config.transport == TransportType.STDIO or (
                config.url and ("localhost" in config.url or "127.0.0.1" in config.url)
            )
            allowed, reason = self._policy_manager.can_connect(
                server_name=name,
                transport=config.transport.value,
                command=config.command,
                is_local=is_local or False,
            )
            if not allowed:
                _mark_error(f"Connection blocked by policy: {reason}")
                return False

        last_error: str | None = None

        for attempt in range(max_retries):
            try:
                if attempt > 0:
                    delay = 2**attempt
                    logger.info(
                        "Retrying %s in %ss (attempt %d/%d)", name, delay, attempt + 1, max_retries
                    )
                    await asyncio.sleep(delay)

                # Build connection dict for MultiServerMCPClient
                connection = {
                    "transport": config.transport.value,
                    "command": config.command,
                    "args": config.args,
                }
                if config.env:
                    connection["env"] = config.env
                if config.url and config.transport == TransportType.SSE:
                    connection["url"] = config.url

                # Create client
                client = MultiServerMCPClient(connections={name: connection})
                tools = await client.get_tools()

                # Prefix tool names
                for tool in tools:
                    tool.name = f"{name}_{tool.name}"

                self._clients[name] = client
                self._tools[name] = list(tools)
                self._status[name] = McpServerStatus(
                    name=name,
                    status=ConnectionStatus.CONNECTED,
                    tools_count=len(tools),
                    last_connected=datetime.now().isoformat(),
                )

                logger.info(
                    "Connected to MCP server '%s' with %d tools: %s",
                    name,
                    len(tools),
                    [t.name for t in tools],
                )
                return True

            except Exception as e:
                last_error = str(e)
                logger.warning("Failed to connect to '%s': %s", name, e)

        # All retries failed
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.ERROR,
            error_message=last_error,
        )
        logger.error("Failed to connect to '%s' after %d attempts", name, max_retries)
        return False

    async def _disconnect_server(self, name: str) -> None:
        """Disconnect from an MCP server."""
        if name in self._clients:
            del self._clients[name]
        if name in self._tools:
            del self._tools[name]
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.DISCONNECTED,
        )
        logger.info("Disconnected from MCP server '%s'", name)
