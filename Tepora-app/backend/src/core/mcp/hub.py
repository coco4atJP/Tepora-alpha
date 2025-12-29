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
import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from .models import (
    McpToolsConfig,
    McpServerConfig,
    McpServerStatus,
    ConnectionStatus,
    TransportType,
)

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
    """
    
    def __init__(self, config_path: Path):
        """
        Initialize McpHub.
        
        Args:
            config_path: Path to mcp_tools_config.json
        """
        self.config_path = config_path
        self._config: McpToolsConfig = McpToolsConfig()
        self._clients: Dict[str, MultiServerMCPClient] = {}
        self._tools: Dict[str, List[BaseTool]] = {}  # server_name -> tools
        self._status: Dict[str, McpServerStatus] = {}
        self._initialized = False
        self._watcher_task: Optional[asyncio.Task] = None
        self._last_config_mtime: float = 0
        
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
                elif (old_cfg.command != new_cfg.command or 
                      old_cfg.args != new_cfg.args or 
                      old_cfg.env != new_cfg.env):
                    await self._disconnect_server(name)
                    if new_cfg.enabled:
                        await self._connect_server(name, new_cfg)
                        
        logger.info("Config reload complete")
        
    def get_all_tools(self) -> List[BaseTool]:
        """Get all tools from all connected servers."""
        all_tools: List[BaseTool] = []
        for tools in self._tools.values():
            all_tools.extend(tools)
        return all_tools
    
    def get_connection_status(self) -> Dict[str, McpServerStatus]:
        """Get connection status for all configured servers."""
        return self._status.copy()
    
    def get_config(self) -> McpToolsConfig:
        """Get current configuration."""
        return self._config
    
    async def update_config(self, new_config: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """
        Update configuration and save to file.
        
        Args:
            new_config: New configuration data
            
        Returns:
            (success, error_message)
        """
        try:
            # Validate with lenient parsing
            config = self._parse_config_lenient(new_config)
            
            # Write to file
            self.config_path.write_text(
                json.dumps(new_config, indent=2, ensure_ascii=False),
                encoding="utf-8"
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
    
    # --- Private Methods ---
    
    async def _load_config(self) -> None:
        """Load configuration from file."""
        raw_config = self._read_config_raw()
        self._config = self._parse_config_lenient(raw_config)
        if self.config_path.exists():
            self._last_config_mtime = self.config_path.stat().st_mtime
        
    def _read_config_raw(self) -> Dict[str, Any]:
        """Read raw config from file."""
        try:
            if not self.config_path.exists():
                logger.warning("Config file not found: %s", self.config_path)
                return {"mcpServers": {}}
            return json.loads(self.config_path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error("Failed to read config file: %s", e)
            return {"mcpServers": {}}
    
    def _parse_config_lenient(self, raw_config: Dict[str, Any]) -> McpToolsConfig:
        """
        Parse config with lenient validation.
        Handles missing optional fields and unknown fields gracefully.
        """
        servers: Dict[str, McpServerConfig] = {}
        
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
        self, 
        name: str, 
        config: McpServerConfig,
        max_retries: int = 3
    ) -> bool:
        """
        Connect to a single MCP server.
        
        Returns True if connection successful.
        """
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.CONNECTING,
        )
        
        last_error: Optional[str] = None
        
        for attempt in range(max_retries):
            try:
                if attempt > 0:
                    delay = 2 ** attempt
                    logger.info("Retrying %s in %ss (attempt %d/%d)", 
                               name, delay, attempt + 1, max_retries)
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
                
                logger.info("Connected to MCP server '%s' with %d tools: %s",
                           name, len(tools), [t.name for t in tools])
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
