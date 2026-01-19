"""
MCP Installer - Smart command generation and installation helpers.

Provides:
- Command generation based on runtime hints (npx, uvx, docker)
- Environment variable schema extraction
- Config generation for new server installations
- Server key normalization utilities
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .models import (
    EnvVarSchema,
    McpRegistryServer,
    McpServerConfig,
    McpServerMetadata,
    PackageInfo,
    TransportType,
)

logger = logging.getLogger(__name__)

# Pattern for unsafe characters in server keys
_SERVER_KEY_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9_-]")


class McpInstaller:
    """
    Helper for installing MCP servers from registry.

    Generates appropriate commands and configurations based on
    package runtime hints and user-provided environment variables.
    """

    # --- Server Key Utilities ---

    @staticmethod
    def normalize_server_key(raw: str) -> str:
        """
        Normalize a registry/server identifier into a safe MCP server key.

        This key is used as:
        - the config key in `mcp_tools_config.json`
        - the prefix for tool names (e.g. `{server_key}_{tool_name}`)

        Args:
            raw: Raw identifier (e.g. "io.github.user/weather")

        Returns:
            Safe key (e.g. "weather")
        """
        if not raw:
            return "mcp_server"

        # Prefer the segment after the namespace (reverse-DNS name like `io.github.user/weather`)
        base = raw.split("/", 1)[-1]
        base = _SERVER_KEY_UNSAFE_CHARS.sub("_", base).strip("_")
        return base or "mcp_server"

    @staticmethod
    def make_unique_key(base: str, existing: set[str]) -> str:
        """
        Generate a unique server key by appending a suffix if needed.

        Args:
            base: Base key name
            existing: Set of existing key names

        Returns:
            Unique key (e.g. "weather" or "weather_2")
        """
        if base not in existing:
            return base
        i = 2
        while f"{base}_{i}" in existing:
            i += 1
        return f"{base}_{i}"

    @staticmethod
    def dump_config(server: McpServerConfig) -> dict[str, Any]:
        """
        Serialize McpServerConfig into the config file shape.

        Preserves all metadata and transport settings.

        Args:
            server: Server configuration to serialize

        Returns:
            Dictionary suitable for JSON serialization
        """
        data: dict[str, Any] = {
            "command": server.command,
            "args": server.args,
            "env": server.env or {},
            "enabled": server.enabled,
            "transport": getattr(server.transport, "value", server.transport),
        }
        if getattr(server, "url", None):
            data["url"] = server.url
        if server.metadata is not None:
            data["metadata"] = server.metadata.model_dump(exclude_none=True)
        return data

    # --- Config Generation ---

    @staticmethod
    def generate_config(
        server: McpRegistryServer,
        runtime: str | None = None,
        env_values: dict[str, str] | None = None,
    ) -> McpServerConfig:
        """
        Generate server configuration from registry server info.

        Args:
            server: Registry server information
            runtime: Preferred runtime ('npx', 'uvx', 'docker').
                    If None, uses the first package's runtimeHint.
            env_values: Environment variable values

        Returns:
            McpServerConfig ready to be added to config file
        """
        # Find the appropriate package
        package = McpInstaller._find_package(server.packages, runtime)
        if not package:
            raise ValueError(f"No suitable package found for server '{server.name}'")

        # Generate command based on runtime
        command, args = McpInstaller._generate_command(package)

        # Build environment variables
        env = dict(env_values) if env_values else {}

        # Fill in defaults for missing required vars
        for env_schema in server.environmentVariables:
            if env_schema.name not in env and env_schema.default:
                env[env_schema.name] = env_schema.default

        return McpServerConfig(
            command=command,
            args=args,
            env=env,
            enabled=True,
            transport=TransportType.STDIO,
            metadata=McpServerMetadata(
                name=server.name,
                description=server.description,
            ),
        )

    @staticmethod
    def extract_env_schema(server: McpRegistryServer) -> list[EnvVarSchema]:
        """
        Extract environment variable schema for UI form generation.

        Args:
            server: Registry server information

        Returns:
            List of environment variable schemas
        """
        return server.environmentVariables

    @staticmethod
    def get_available_runtimes(server: McpRegistryServer) -> list[str]:
        """
        Get list of available runtimes for a server.

        Args:
            server: Registry server information

        Returns:
            List of runtime hints (e.g., ['npx', 'uvx'])
        """
        runtimes = []
        for pkg in server.packages:
            if pkg.runtimeHint and pkg.runtimeHint not in runtimes:
                runtimes.append(pkg.runtimeHint)
        return runtimes

    @staticmethod
    def preview_command(
        server: McpRegistryServer,
        runtime: str | None = None,
        env_values: dict[str, str] | None = None,
    ) -> str:
        """
        Generate a preview of the command that would be executed.

        Args:
            server: Registry server information
            runtime: Preferred runtime
            env_values: Environment variable values

        Returns:
            Command string for display
        """
        try:
            config = McpInstaller.generate_config(server, runtime, env_values)
            parts = [config.command] + config.args

            # Add env vars for display
            env_str = ""
            if config.env:
                env_parts = [f"{k}={v}" for k, v in config.env.items()]
                env_str = " ".join(env_parts) + " "

            return env_str + " ".join(parts)
        except Exception as e:
            return f"Error generating command: {e}"

    @staticmethod
    def generate_consent_payload(
        server: McpRegistryServer,
        runtime: str | None = None,
        env_values: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """
        Generate consent payload for user approval before installation.

        This is used in the 2-step install flow:
        1. Preview the command and get user consent
        2. Actually execute the installation

        Args:
            server: Registry server information
            runtime: Preferred runtime
            env_values: Environment variable values

        Returns:
            Dictionary with command details and warnings for user review
        """
        config = McpInstaller.generate_config(server, runtime, env_values)

        # Mask sensitive environment variables
        masked_env = {}
        for key, value in (config.env or {}).items():
            key_lower = key.lower()
            if any(
                s in key_lower for s in ["key", "secret", "token", "password", "credential", "auth"]
            ):
                masked_env[key] = "***MASKED***"
            else:
                masked_env[key] = value

        # Generate command preview
        full_command = McpInstaller.preview_command(server, runtime, env_values)

        # Generate warnings based on command patterns
        warnings = McpInstaller._generate_warnings(config.command, config.args)

        return {
            "server_id": server.id,
            "server_name": server.name,
            "description": server.description,
            "command": config.command,
            "args": config.args,
            "env": masked_env,
            "full_command": full_command,
            "warnings": warnings,
            "requires_consent": True,
            "runtime": runtime or (server.packages[0].runtimeHint if server.packages else None),
        }

    @staticmethod
    def _generate_warnings(command: str, args: list[str]) -> list[str]:
        """Generate security warnings based on command patterns."""
        warnings = []
        full_cmd = f"{command} {' '.join(args)}".lower()

        if "docker" in command:
            warnings.append("Docker container execution - may have system access")
            if "--privileged" in full_cmd:
                warnings.append("⚠️ PRIVILEGED MODE - Full system access!")
            if "-v" in args or "--volume" in full_cmd:
                warnings.append("Volume mount detected - filesystem access")

        if "npx -y" in full_cmd:
            warnings.append("External npm package download and execution")

        if "uvx" in command:
            warnings.append("External Python package download and execution")

        if "sudo" in full_cmd:
            warnings.append("⚠️ ROOT PRIVILEGES REQUESTED")

        if "rm " in full_cmd or "del " in full_cmd:
            warnings.append("⚠️ Delete operation detected")

        if not warnings:
            warnings.append("Standard tool execution")

        return warnings

    @staticmethod
    def _find_package(
        packages: list[PackageInfo], preferred_runtime: str | None
    ) -> PackageInfo | None:
        """Find the best package to use."""
        if not packages:
            return None

        # If runtime specified, find matching package
        if preferred_runtime:
            for pkg in packages:
                if pkg.runtimeHint == preferred_runtime:
                    return pkg

        # Otherwise return first package with a runtime hint
        for pkg in packages:
            if pkg.runtimeHint:
                return pkg

        # Last resort: return first package
        return packages[0] if packages else None

    @staticmethod
    def _generate_command(package: PackageInfo) -> tuple[str, list[str]]:
        """
        Generate command and args for a package.

        Returns:
            (command, args) tuple
        """
        runtime = package.runtimeHint or "npx"
        pkg_name = package.package_name

        if runtime == "npx":
            return "npx", ["-y", pkg_name]

        elif runtime in ("uvx", "python"):
            return "uvx", [pkg_name]

        elif runtime == "docker":
            return "docker", ["run", "-i", "--rm", pkg_name]

        else:
            # Unknown runtime, try to use as command directly
            logger.warning("Unknown runtime '%s', using as command", runtime)
            return runtime, [pkg_name]


# Convenience functions for direct import
def generate_command(
    runtime_hint: str,
    package_name: str,
    env_vars: dict[str, str] | None = None,
) -> McpServerConfig:
    """
    Generate a server config from runtime and package info.

    Args:
        runtime_hint: Runtime type ('npx', 'uvx', 'docker')
        package_name: Package identifier
        env_vars: Environment variables

    Returns:
        McpServerConfig
    """
    # Create a minimal PackageInfo
    package = PackageInfo(
        name=package_name,
        runtimeHint=runtime_hint,
    )

    command, args = McpInstaller._generate_command(package)

    return McpServerConfig(
        command=command,
        args=args,
        env=env_vars or {},
        enabled=True,
        transport=TransportType.STDIO,
    )


def extract_env_schema(server_data: dict[str, Any]) -> list[EnvVarSchema]:
    """
    Extract environment variable schema from raw server data.

    Args:
        server_data: Raw server data from registry

    Returns:
        List of EnvVarSchema
    """
    schemas = []
    for env in server_data.get("environmentVariables", []):
        schemas.append(
            EnvVarSchema(
                name=env.get("name", ""),
                description=env.get("description"),
                isRequired=env.get("isRequired", False),
                isSecret=env.get("isSecret", False),
                default=env.get("default"),
            )
        )
    return schemas
