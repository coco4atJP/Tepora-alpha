from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient, StdioConnection

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from ..mcp.hub import McpHub

__all__ = [
    "load_connections_from_config",
    "load_mcp_tools_robust",
]


def load_connections_from_config(config_path: Path) -> dict[str, StdioConnection]:
    """設定ファイルからMCPサーバー接続情報を読み込む。

    Args:
        config_path: mcp_tools_config.json へのパス

    Returns:
        サーバー名をキーとしたStdioConnection辞書
    """
    if not config_path.exists():
        logger.warning("MCP config file not found: %s", config_path)
        return {}
    try:
        config_data = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to load MCP config from %s: %s", config_path, exc, exc_info=True)
        return {}

    if not isinstance(config_data, dict):
        logger.warning(
            "Invalid MCP config format in %s (expected object, got %s)",
            config_path,
            type(config_data).__name__,
        )
        return {}

    servers_config = config_data.get("mcpServers", {})
    if not isinstance(servers_config, dict):
        logger.warning(
            "Invalid MCP config in %s: mcpServers must be an object, got %s",
            config_path,
            type(servers_config).__name__,
        )
        return {}

    connections: dict[str, StdioConnection] = {}
    for server_name, server_config in servers_config.items():
        if not isinstance(server_config, dict):
            logger.warning(
                "Skipping MCP server '%s': invalid config entry (%s)",
                server_name,
                type(server_config).__name__,
            )
            continue
        if not server_config.get("enabled", True):
            logger.info("Skipping disabled MCP server config: %s", server_name)
            continue

        # Fallback loader currently supports only stdio transport.
        if (server_config.get("transport") or "stdio") != "stdio":
            logger.warning(
                "Skipping MCP server '%s': unsupported transport '%s'",
                server_name,
                server_config.get("transport"),
            )
            continue

        command = server_config.get("command")
        if not command:
            logger.warning("Skipping server '%s': 'command' key is missing.", server_name)
            continue

        args = server_config.get("args", [])
        if not isinstance(args, list):
            logger.warning(
                "Invalid args for MCP server '%s' (expected list, got %s)",
                server_name,
                type(args).__name__,
            )
            args = []

        env = server_config.get("env") or {}
        if not isinstance(env, dict):
            logger.warning(
                "Invalid env for MCP server '%s' (expected object, got %s)",
                server_name,
                type(env).__name__,
            )
            env = {}

        connections[server_name] = StdioConnection(
            transport="stdio",
            command=command,
            args=args,
            env=env,
        )
        logger.info("Loaded MCP server config: %s", server_name)
    return connections


async def load_mcp_tools_robust(
    config_path: Path,
) -> tuple[list[BaseTool], list[MultiServerMCPClient]]:
    """複数のMCPサーバーからツールを堅牢にロードする。

    各サーバーへの接続は独立して行われ、一部のサーバーが失敗しても
    他のサーバーからのツールは正常にロードされる。

    Args:
        config_path: mcp_tools_config.json へのパス

    Returns:
        (ロードされたLangChainツールのリスト, 保持が必要なMCPクライアントインスタンスのリスト)
    """
    connections = load_connections_from_config(config_path)
    if not connections:
        logger.warning("No MCP server connections found.")
        return [], []

    tools: list[BaseTool] = []
    clients: list[MultiServerMCPClient] = []

    for server_name, connection in connections.items():
        try:
            server_tools, client = await _load_single_server(server_name, connection)
            tools.extend(server_tools)
            clients.append(client)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Failed to load tools from MCP server '%s': %s",
                server_name,
                exc,
                exc_info=True,
            )

    return tools, clients


async def _load_single_server(
    server_name: str, connection: StdioConnection, max_retries: int = 3
) -> tuple[list[BaseTool], MultiServerMCPClient]:
    """単一のMCPサーバーからツールをロードする（リトライ対応）。

    Args:
        server_name: MCPサーバーの識別名
        connection: サーバーへの接続情報
        max_retries: 最大リトライ回数

    Returns:
        (サーバーから取得したツールのリスト, MCPクライアントインスタンス)

    Raises:
        Exception: 全リトライが失敗した場合
    """
    last_exception: Exception | None = None

    for attempt in range(max_retries):
        client: MultiServerMCPClient | None = None
        try:
            if attempt:
                delay = 2**attempt
                logger.info("Waiting %s seconds before retrying server %s", delay, server_name)
                await asyncio.sleep(delay)

            # MultiServerMCPClient (v0.1.0+) はコンテキストマネージャとして使用できないため
            # インスタンス化して直接使用する。
            # また、クライアントインスタンスがGCされると接続が切れる可能性があるため、
            # 呼び出し元に返して保持させる必要がある。
            client = MultiServerMCPClient(connections={server_name: connection})
            discovered_tools = await client.get_tools()

            # ツール名にサーバー名プレフィックスを付与（名前衝突防止）
            for tool in discovered_tools:
                tool.name = f"{server_name}_{tool.name}"

            logger.info(
                "Loaded %d tools from MCP server '%s': %s",
                len(discovered_tools),
                server_name,
                [t.name for t in discovered_tools],
            )
            return list(discovered_tools), client

        except Exception as exc:  # noqa: BLE001
            last_exception = exc
            if client:
                try:
                    closer = getattr(client, "aclose", None)
                    if callable(closer):
                        result = closer()
                        if asyncio.iscoroutine(result):
                            await result
                    else:
                        closer = getattr(client, "close", None)
                        if callable(closer):
                            result = closer()
                            if asyncio.iscoroutine(result):
                                await result
                except Exception as close_exc:  # noqa: BLE001
                    logger.debug(
                        "Failed to close MCP client for '%s': %s",
                        server_name,
                        close_exc,
                        exc_info=True,
                    )
            logger.warning(
                "Attempt %s failed for server '%s': %s",
                attempt + 1,
                server_name,
                exc,
                exc_info=True,
            )

    # 全リトライ失敗時
    if last_exception:
        raise last_exception
    # ここには到達しないはずだが型チェックのために例外送出
    raise RuntimeError(f"Unexpected unreachable code in _load_single_server for {server_name}")


from .base import ToolProvider  # noqa: E402


class McpToolProvider(ToolProvider):
    """
    Provider for loading tools from MCP servers.
    Manages the lifecycle of MCP clients.
    """

    def __init__(self, config_path: Path, hub: McpHub | None = None):
        self.config_path = config_path
        self._hub = hub
        self._clients: list[MultiServerMCPClient] = []

    @property
    def name(self) -> str:
        """Return provider name."""
        return "mcp"

    async def load_tools(self) -> list[BaseTool]:
        # Prefer the shared McpHub instance (web server) to avoid duplicate
        # connections and to respect enable/disable/policy decisions.
        if self._hub is not None:
            if not self._hub.initialized:
                await self._hub.initialize()
            return self._hub.get_all_tools()

        logger.info("Loading MCP tools via Provider from %s", self.config_path)
        # Use existing logic but manage clients internally
        tools, clients = await load_mcp_tools_robust(self.config_path)
        self._clients.extend(clients)
        return tools

    def cleanup(self):
        """
        Hold references to clients, so 'cleanup' might involve closing them if the client supported it.
        Current MultiServerMCPClient doesn't strictly need close, but we clear ref.
        """
        self._clients.clear()
