"""
MCP Config Service - Configuration file management for MCP servers.

Responsibilities:
- Reading and writing mcp_tools_config.json
- Lenient config parsing for third-party servers
- Config file watching and hot-reload triggering
- Config hash computation and trust verification
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .models import McpServerConfig, McpToolsConfig

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class McpConfigService:
    """
    Service for managing MCP configuration files.

    Features:
    - Reads and writes mcp_tools_config.json
    - Lenient parsing for third-party server quirks
    - Config file watching with polling
    - Trust verification via SHA256 hashes
    """

    def __init__(self, config_path: Path) -> None:
        """
        Initialize the config service.

        Args:
            config_path: Path to mcp_tools_config.json
        """
        self.config_path = config_path
        self._last_mtime: float = 0
        self._watcher_task: asyncio.Task[None] | None = None

        # Trust management
        self._trusted_hashes: set[str] = set()
        self._pending_changes: dict[str, dict[str, Any]] = {}
        self._load_trusted_hashes()

    @property
    def last_mtime(self) -> float:
        """Get the last modification time of the config file."""
        return self._last_mtime

    def read_raw(self) -> dict[str, Any]:
        """
        Read raw configuration from file.

        Returns:
            Raw config dict, or empty mcpServers dict on error.
        """
        try:
            if not self.config_path.exists():
                logger.warning("Config file not found: %s", self.config_path)
                return {"mcpServers": {}}

            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                logger.warning(
                    "Invalid MCP config format (expected object, got %s)",
                    type(raw).__name__,
                )
                return {"mcpServers": {}}
            return raw
        except Exception as e:
            logger.error("Failed to read config file: %s", e, exc_info=True)
            return {"mcpServers": {}}

    def parse_lenient(self, raw_config: dict[str, Any]) -> McpToolsConfig:
        """
        Parse config with lenient validation.

        Handles missing optional fields and unknown fields gracefully.

        Args:
            raw_config: Raw config dictionary

        Returns:
            Parsed McpToolsConfig
        """
        servers: dict[str, McpServerConfig] = {}

        for name, server_data in raw_config.get("mcpServers", {}).items():
            if not isinstance(server_data, dict):
                logger.warning(
                    "Skipping server '%s': invalid config entry (%s)",
                    name,
                    type(server_data).__name__,
                )
                continue

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
                logger.warning(
                    "Lenient parse: skipping server '%s' due to: %s",
                    name,
                    e,
                    exc_info=True,
                )
                # Still try to create a minimal config
                try:
                    servers[name] = McpServerConfig(
                        command=server_data.get("command", ""),
                        args=server_data.get("args", []),
                        env=server_data.get("env", {}),
                        enabled=server_data.get("enabled", True),
                    )
                except Exception as exc:
                    logger.debug(
                        "Lenient parse: failed to build minimal config for '%s': %s",
                        name,
                        exc,
                        exc_info=True,
                    )

        return McpToolsConfig(mcpServers=servers)

    def load(self) -> McpToolsConfig:
        """
        Load and parse configuration from file.

        Returns:
            Parsed McpToolsConfig
        """
        raw_config = self.read_raw()
        config = self.parse_lenient(raw_config)
        if self.config_path.exists():
            self._last_mtime = self.config_path.stat().st_mtime
        return config

    def save(self, config: dict[str, Any]) -> None:
        """
        Save configuration to file.

        Args:
            config: Configuration dict to save

        Raises:
            Exception: If write fails
        """
        self.config_path.write_text(
            json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        self._last_mtime = self.config_path.stat().st_mtime

    # --- File Watching ---

    def start_watcher(
        self,
        on_change: Callable[[], Any],
        poll_interval: float = 2.0,
    ) -> None:
        """
        Start watching config file for changes.

        Uses polling for cross-platform compatibility.

        Args:
            on_change: Callback to invoke when config changes (can be async)
            poll_interval: Seconds between checks
        """
        if self._watcher_task:
            logger.warning("Config watcher already running")
            return

        async def watch_loop() -> None:
            while True:
                try:
                    await asyncio.sleep(poll_interval)
                    if self.config_path.exists():
                        mtime = self.config_path.stat().st_mtime
                        if mtime > self._last_mtime:
                            logger.info("Config file changed, triggering reload...")
                            self._last_mtime = mtime
                            result = on_change()
                            if asyncio.iscoroutine(result):
                                await result
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error("Error in config watcher: %s", e, exc_info=True)

        self._watcher_task = asyncio.create_task(watch_loop())
        logger.info("Started config file watcher (poll interval: %ss)", poll_interval)

    async def stop_watcher(self) -> None:
        """Stop the config file watcher."""
        if self._watcher_task:
            self._watcher_task.cancel()
            try:
                await self._watcher_task
            except asyncio.CancelledError:
                pass
            self._watcher_task = None
            logger.info("Stopped config file watcher")

    # --- Trust Management ---

    def compute_hash(self, config: dict[str, Any]) -> str:
        """
        Compute SHA256 hash of config for trust verification.

        Args:
            config: Config dict to hash

        Returns:
            Hex-encoded SHA256 hash
        """
        config_str = json.dumps(config, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(config_str.encode()).hexdigest()

    def is_trusted(self, config: dict[str, Any] | None = None) -> bool:
        """
        Check if config is in trusted state.

        Args:
            config: Config to check, or None to read from file

        Returns:
            True if config hash is in trusted set
        """
        if config is None:
            config = self.read_raw()
        return self.compute_hash(config) in self._trusted_hashes

    def trust_config(self, config: dict[str, Any] | None = None) -> None:
        """
        Mark config as trusted.

        Args:
            config: Config to trust, or None to trust current file
        """
        if config is None:
            config = self.read_raw()
        config_hash = self.compute_hash(config)
        self._trusted_hashes.add(config_hash)
        self._save_trusted_hashes()
        logger.info("Config marked as trusted (hash: %s...)", config_hash[:8])

    def _load_trusted_hashes(self) -> None:
        """Load trusted config hashes from storage."""
        trust_file = self.config_path.parent / ".mcp_trusted_hashes"
        try:
            if trust_file.exists():
                data = json.loads(trust_file.read_text(encoding="utf-8"))
                self._trusted_hashes = set(data.get("hashes", []))
                logger.debug("Loaded %d trusted hashes", len(self._trusted_hashes))
        except Exception as e:
            logger.warning("Failed to load trusted hashes: %s", e, exc_info=True)
            self._trusted_hashes = set()

    def _save_trusted_hashes(self) -> None:
        """Save trusted config hashes to storage."""
        trust_file = self.config_path.parent / ".mcp_trusted_hashes"
        try:
            trust_file.write_text(
                json.dumps({"hashes": list(self._trusted_hashes)}, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning("Failed to save trusted hashes: %s", e, exc_info=True)

    # --- Pending Changes Management ---

    def detect_changes(self, current_config: McpToolsConfig) -> dict[str, Any] | None:
        """
        Detect if current config file differs from last trusted state.

        Args:
            current_config: Currently loaded config to compare against

        Returns:
            Change details if untrusted changes detected, None if trusted.
        """
        raw_config = self.read_raw()
        config_hash = self.compute_hash(raw_config)

        if config_hash in self._trusted_hashes:
            return None

        # Detect specific changes
        old_servers = set(current_config.mcpServers.keys())
        new_config = self.parse_lenient(raw_config)
        new_servers = set(new_config.mcpServers.keys())

        added = new_servers - old_servers
        removed = old_servers - new_servers
        modified = []

        for name in old_servers & new_servers:
            old_cfg = current_config.mcpServers[name]
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

    def approve_pending_change(self, change_id: str) -> dict[str, Any] | None:
        """
        Approve and retrieve a pending config change.

        Returns:
            The change data if found and approved, None otherwise.
        """
        if change_id not in self._pending_changes:
            return None

        change = self._pending_changes.pop(change_id)
        config_hash = change.get("config_hash")
        if config_hash:
            self._trusted_hashes.add(config_hash)
            self._save_trusted_hashes()

        logger.info("Approved pending change: %s", change_id)
        return change

    def reject_pending_change(self, change_id: str) -> bool:
        """Reject and discard a pending config change."""
        if change_id not in self._pending_changes:
            return False

        del self._pending_changes[change_id]
        logger.info("Rejected pending change: %s", change_id)
        return True
