"""
Pydantic models for MCP configuration and registry data.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional
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
    name: Optional[str] = Field(default=None, description="Display name")
    description: Optional[str] = Field(default=None, description="Server description")
    icon: Optional[str] = Field(default=None, description="Icon URL or emoji")


class McpServerConfig(BaseModel):
    """Configuration for a single MCP server."""
    command: str = Field(..., description="Command to execute")
    args: List[str] = Field(default_factory=list, description="Command arguments")
    env: Dict[str, str] = Field(default_factory=dict, description="Environment variables")
    enabled: bool = Field(default=True, description="Whether the server is enabled")
    transport: TransportType = Field(default=TransportType.STDIO, description="Transport type")
    url: Optional[str] = Field(default=None, description="SSE server URL (for SSE transport)")
    metadata: Optional[McpServerMetadata] = Field(default=None, description="Display metadata")



class McpToolsConfig(BaseModel):
    """Root configuration for MCP tools."""
    mcpServers: Dict[str, McpServerConfig] = Field(
        default_factory=dict, 
        description="Map of server name to configuration"
    )


class McpServerStatus(BaseModel):
    """Runtime status of an MCP server."""
    name: str
    status: ConnectionStatus
    tools_count: int = 0
    error_message: Optional[str] = None
    last_connected: Optional[str] = None


# --- Registry Models ---

class EnvVarSchema(BaseModel):
    """Environment variable schema from registry."""
    name: str
    description: Optional[str] = None
    isRequired: bool = False
    isSecret: bool = False
    default: Optional[str] = None


class PackageInfo(BaseModel):
    """Package information from registry."""
    name: str
    version: Optional[str] = None
    registry: Optional[str] = None  # e.g., "npm", "pypi"
    runtimeHint: Optional[str] = None  # e.g., "npx", "uvx", "docker"


class McpRegistryServer(BaseModel):
    """Server information from official MCP registry."""
    id: str
    name: str
    description: Optional[str] = None
    vendor: Optional[str] = None
    sourceUrl: Optional[str] = None
    homepage: Optional[str] = None
    license: Optional[str] = None
    packages: List[PackageInfo] = Field(default_factory=list)
    environmentVariables: List[EnvVarSchema] = Field(default_factory=list)
    
    # Additional computed fields
    icon: Optional[str] = None
    category: Optional[str] = None


# Note: McpServerMetadata is defined before McpServerConfig to avoid forward reference issues
