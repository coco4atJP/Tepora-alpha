"""
MCP Connection Manager - Lifecycle management for MCP server connections.

Responsibilities:
- Connecting and disconnecting MCP servers
- Managing client instances and tools
- Tracking connection status
- Policy enforcement for connections
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import TYPE_CHECKING

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient, SSEConnection, StdioConnection

from .models import ConnectionStatus, McpServerConfig, McpServerStatus, TransportType

if TYPE_CHECKING:
    from .mcp_policy import McpPolicyManager

logger = logging.getLogger(__name__)


class McpConnectionManager:
    """
    Manager for MCP server connections.

    Features:
    - Connects/disconnects individual servers
    - Manages client instances and tool discovery
    - Tracks connection status per server
    - Enforces connection policies
    """

    def __init__(self, policy_manager: McpPolicyManager | None = None) -> None:
        """
        Initialize the connection manager.

        Args:
            policy_manager: Optional policy manager for connection enforcement
        """
        self._policy_manager = policy_manager
        self._clients: dict[str, MultiServerMCPClient] = {}
        self._tools: dict[str, list[BaseTool]] = {}  # server_name -> tools
        self._status: dict[str, McpServerStatus] = {}

    @property
    def policy_manager(self) -> McpPolicyManager | None:
        """Get the policy manager instance."""
        return self._policy_manager

    def get_all_tools(self) -> list[BaseTool]:
        """Get all tools from all connected servers."""
        all_tools: list[BaseTool] = []
        for tools in self._tools.values():
            all_tools.extend(tools)
        return all_tools

    def get_connection_status(self) -> dict[str, McpServerStatus]:
        """Get connection status for all servers."""
        return self._status.copy()

    def get_client(self, name: str) -> MultiServerMCPClient | None:
        """Get client for a specific server."""
        return self._clients.get(name)

    async def connect(
        self,
        name: str,
        config: McpServerConfig,
        max_retries: int = 3,
    ) -> bool:
        """
        Connect to a single MCP server.

        Args:
            name: Server name/key
            config: Server configuration
            max_retries: Maximum connection attempts

        Returns:
            True if connection successful
        """
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.CONNECTING,
        )

        # Helper to mark error
        def _mark_error(err_msg: str) -> None:
            self._status[name] = McpServerStatus(
                name=name,
                status=ConnectionStatus.ERROR,
                error_message=err_msg,
            )
            logger.error(err_msg)

        # Check policy if available
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
            client: MultiServerMCPClient | None = None
            try:
                if attempt > 0:
                    delay = 2**attempt
                    logger.info(
                        "Retrying %s in %ss (attempt %d/%d)",
                        name,
                        delay,
                        attempt + 1,
                        max_retries,
                    )
                    await asyncio.sleep(delay)

                # Build connection dict for MultiServerMCPClient
                connection: StdioConnection | SSEConnection
                if config.transport == TransportType.STDIO:
                    connection = {
                        "transport": "stdio",
                        "command": config.command,
                        "args": config.args,
                    }
                    if config.env:
                        connection["env"] = dict(config.env)
                elif config.transport == TransportType.SSE:
                    if not config.url:
                        raise ValueError(f"MCP server '{name}' uses SSE transport but has no URL")
                    connection = {"transport": "sse", "url": config.url}
                else:
                    raise ValueError(f"Unsupported MCP transport: {config.transport.value}")

                # Create client
                client = MultiServerMCPClient(connections={name: connection})
                tools = await client.get_tools()

                # Prefix tool names with server name
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
                logger.warning("Failed to connect to '%s': %s", name, e, exc_info=True)
                if client:
                    await self._close_client(name, client)

        # All retries failed
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.ERROR,
            error_message=last_error,
        )
        logger.error("Failed to connect to '%s' after %d attempts", name, max_retries)
        return False

    async def disconnect(self, name: str) -> None:
        """
        Disconnect from an MCP server.

        Args:
            name: Server name to disconnect
        """
        client = self._clients.pop(name, None)
        if client:
            await self._close_client(name, client)
        if name in self._tools:
            del self._tools[name]
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.DISCONNECTED,
        )
        logger.info("Disconnected from MCP server '%s'", name)

    async def connect_all(
        self,
        servers: dict[str, McpServerConfig],
    ) -> None:
        """
        Connect to all enabled servers.

        Args:
            servers: Dict of server name -> config
        """
        for name, config in servers.items():
            if config.enabled:
                await self.connect(name, config)
            else:
                self._status[name] = McpServerStatus(
                    name=name,
                    status=ConnectionStatus.DISCONNECTED,
                    tools_count=0,
                )

    async def disconnect_all(self) -> None:
        """Disconnect from all servers."""
        for name, client in list(self._clients.items()):
            await self._close_client(name, client)
        self._clients.clear()
        self._tools.clear()
        self._status.clear()
        logger.info("Disconnected from all MCP servers")

    async def _close_client(self, name: str, client: MultiServerMCPClient) -> None:
        """
        Best-effort close for MCP clients.

        Handles both async and sync close methods.
        """
        try:
            closer = getattr(client, "aclose", None)
            if callable(closer):
                result = closer()
                if asyncio.iscoroutine(result):
                    await result
                return

            closer = getattr(client, "close", None)
            if callable(closer):
                result = closer()
                if asyncio.iscoroutine(result):
                    await result
        except Exception as exc:
            logger.debug("Failed to close MCP client '%s': %s", name, exc, exc_info=True)

    def mark_disconnected(self, name: str) -> None:
        """
        Mark a server as disconnected without closing client.

        Used when server is disabled but client may not exist.
        """
        self._status[name] = McpServerStatus(
            name=name,
            status=ConnectionStatus.DISCONNECTED,
        )
