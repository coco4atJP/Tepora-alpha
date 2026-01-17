"""
MCP Policy Manager - Controls which MCP servers can connect.

Implements:
- Connection policy enforcement (LOCAL_ONLY, STDIO_ONLY, ALLOWLIST)
- Default deny for unknown servers
- Per-server permission management
"""

from __future__ import annotations

import json
import logging
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class McpConnectionPolicy(str, Enum):
    """Connection policy for MCP servers."""

    ALLOW_ALL = "allow_all"  # Allow any server (development only)
    LOCAL_ONLY = "local_only"  # Allow local servers only (stdio, local SSE)
    STDIO_ONLY = "stdio_only"  # Allow only stdio transport
    ALLOWLIST = "allowlist"  # Only allow explicitly approved servers


class McpServerPermission(BaseModel):
    """Permission record for an MCP server."""

    server_name: str
    allowed: bool = False
    transport_types: list[str] = Field(default_factory=list)  # Allowed transport types
    approved_at: str | None = None
    approved_by: str = "user"  # "user", "system", "default"


class McpPolicyConfig(BaseModel):
    """Policy configuration for MCP connections."""

    policy: McpConnectionPolicy = McpConnectionPolicy.LOCAL_ONLY
    server_permissions: dict[str, McpServerPermission] = Field(default_factory=dict)
    blocked_commands: list[str] = Field(
        default_factory=lambda: ["sudo", "rm -rf", "format", "del /f", "shutdown"]
    )
    require_tool_confirmation: bool = True
    first_use_confirmation: bool = True


class McpPolicyManager:
    """
    Manages connection policies for MCP servers.

    Enforces security policies to control which MCP servers
    can be connected and what transports are allowed.
    """

    def __init__(self, policy_path: Path):
        """
        Initialize policy manager.

        Args:
            policy_path: Path to policy configuration file
        """
        self.policy_path = policy_path
        self._config: McpPolicyConfig = McpPolicyConfig()
        self._load_policy()

    def _load_policy(self) -> None:
        """Load policy configuration from file."""
        try:
            if self.policy_path.exists():
                data = json.loads(self.policy_path.read_text(encoding="utf-8"))
                self._config = McpPolicyConfig.model_validate(data)
                logger.info("Loaded MCP policy: %s", self._config.policy.value)
            else:
                # Create default policy file
                self._save_policy()
                logger.info("Created default MCP policy: %s", self._config.policy.value)
        except Exception as e:
            logger.warning("Failed to load policy, using defaults: %s", e, exc_info=True)
            self._config = McpPolicyConfig()

    def _save_policy(self) -> None:
        """Save policy configuration to file."""
        try:
            self.policy_path.parent.mkdir(parents=True, exist_ok=True)
            self.policy_path.write_text(
                json.dumps(self._config.model_dump(), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as e:
            logger.error("Failed to save policy: %s", e, exc_info=True)

    def get_policy(self) -> McpPolicyConfig:
        """Get current policy configuration."""
        return self._config

    def set_policy(self, policy: McpConnectionPolicy) -> None:
        """Set connection policy."""
        self._config.policy = policy
        self._save_policy()
        logger.info("MCP policy set to: %s", policy.value)

    def can_connect(
        self,
        server_name: str,
        transport: str,
        command: str | None = None,
        is_local: bool = True,
    ) -> tuple[bool, str | None]:
        """
        Check if a server connection is allowed by policy.

        Args:
            server_name: Name of the MCP server
            transport: Transport type (stdio, sse, http)
            command: Command to execute (for stdio)
            is_local: Whether the server is local

        Returns:
            (allowed, reason)
        """
        policy = self._config.policy

        # Check blocked commands first
        if command:
            for blocked in self._config.blocked_commands:
                if blocked.lower() in command.lower():
                    return False, f"Blocked command pattern detected: {blocked}"

        # ALLOW_ALL policy
        if policy == McpConnectionPolicy.ALLOW_ALL:
            return True, None

        # STDIO_ONLY policy
        if policy == McpConnectionPolicy.STDIO_ONLY:
            if transport != "stdio":
                return False, f"Policy '{policy.value}' only allows stdio transport"
            return True, None

        # LOCAL_ONLY policy
        if policy == McpConnectionPolicy.LOCAL_ONLY:
            if not is_local:
                return False, f"Policy '{policy.value}' only allows local servers"
            return True, None

        # ALLOWLIST policy
        if policy == McpConnectionPolicy.ALLOWLIST:
            perm = self._config.server_permissions.get(server_name)
            if not perm or not perm.allowed:
                return False, f"Server '{server_name}' not in allowlist"
            if perm.transport_types and transport not in perm.transport_types:
                return False, f"Transport '{transport}' not allowed for '{server_name}'"
            return True, None

        return False, "Unknown policy"

    def approve_server(
        self,
        server_name: str,
        transport_types: list[str] | None = None,
    ) -> None:
        """Add server to allowlist."""
        from datetime import datetime

        self._config.server_permissions[server_name] = McpServerPermission(
            server_name=server_name,
            allowed=True,
            transport_types=transport_types or ["stdio"],
            approved_at=datetime.now().isoformat(),
        )
        self._save_policy()
        logger.info("Server '%s' approved for connection", server_name)

    def revoke_server(self, server_name: str) -> bool:
        """Remove server from allowlist."""
        if server_name in self._config.server_permissions:
            del self._config.server_permissions[server_name]
            self._save_policy()
            logger.info("Server '%s' approval revoked", server_name)
            return True
        return False

    def is_command_blocked(self, command: str) -> bool:
        """Check if a command contains blocked patterns."""
        for blocked in self._config.blocked_commands:
            if blocked.lower() in command.lower():
                return True
        return False

    def requires_confirmation(self, server_name: str, is_first_use: bool = False) -> bool:
        """Check if tool execution requires user confirmation."""
        if is_first_use and self._config.first_use_confirmation:
            return True
        return self._config.require_tool_confirmation

    def get_server_permissions(self) -> dict[str, McpServerPermission]:
        """Get all server permissions."""
        return self._config.server_permissions.copy()

    def update_settings(self, settings: dict[str, Any]) -> None:
        """Update policy settings."""
        if "policy" in settings:
            self._config.policy = McpConnectionPolicy(settings["policy"])
        if "require_tool_confirmation" in settings:
            self._config.require_tool_confirmation = settings["require_tool_confirmation"]
        if "first_use_confirmation" in settings:
            self._config.first_use_confirmation = settings["first_use_confirmation"]
        if "blocked_commands" in settings:
            self._config.blocked_commands = settings["blocked_commands"]
        self._save_policy()
