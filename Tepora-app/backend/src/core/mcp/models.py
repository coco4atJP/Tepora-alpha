"""
Pydantic models for MCP configuration and registry data.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class ConnectionStatus(str, Enum):
    """MCP server connection status."""

    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    ERROR = "error"
    CONNECTING = "connecting"


class TransportType(str, Enum):
    """MCP transport type."""

    STDIO = "stdio"
    SSE = "sse"


class McpServerMetadata(BaseModel):
    """Display metadata for MCP server."""

    name: str | None = Field(default=None, description="Display name")
    description: str | None = Field(default=None, description="Server description")
    icon: str | None = Field(default=None, description="Icon URL or emoji")


class McpServerConfig(BaseModel):
    """Configuration for a single MCP server."""

    command: str = Field(..., description="Command to execute")
    args: list[str] = Field(default_factory=list, description="Command arguments")
    env: dict[str, str] = Field(default_factory=dict, description="Environment variables")
    enabled: bool = Field(default=True, description="Whether the server is enabled")
    transport: TransportType = Field(default=TransportType.STDIO, description="Transport type")
    url: str | None = Field(default=None, description="SSE server URL (for SSE transport)")
    metadata: McpServerMetadata | None = Field(default=None, description="Display metadata")


class McpToolsConfig(BaseModel):
    """Root configuration for MCP tools."""

    mcpServers: dict[str, McpServerConfig] = Field(  # noqa: N815
        default_factory=dict, description="Map of server name to configuration"
    )


class McpServerStatus(BaseModel):
    """Runtime status of an MCP server."""

    name: str
    status: ConnectionStatus
    tools_count: int = 0
    error_message: str | None = None
    last_connected: str | None = None


# --- Registry Models ---


class EnvVarSchema(BaseModel):
    """Environment variable schema from registry."""

    name: str
    description: str | None = None
    isRequired: bool = False  # noqa: N815
    isSecret: bool = False  # noqa: N815
    default: str | None = None


class PackageInfo(BaseModel):
    """Package information from registry."""

    name: str
    version: str | None = None
    registry: str | None = None  # e.g., "npm", "pypi"
    runtimeHint: str | None = None  # noqa: N815 - e.g., "npx", "uvx", "docker"


class McpRegistryServer(BaseModel):
    """Server information from official MCP registry."""

    id: str
    name: str
    description: str | None = None
    vendor: str | None = None
    sourceUrl: str | None = None  # noqa: N815
    homepage: str | None = None
    license: str | None = None
    packages: list[PackageInfo] = Field(default_factory=list)
    environmentVariables: list[EnvVarSchema] = Field(default_factory=list)  # noqa: N815

    # Additional computed fields
    icon: str | None = None
    category: str | None = None


# Note: McpServerMetadata is defined before McpServerConfig to avoid forward reference issues
