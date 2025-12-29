"""
MCP Installer - Smart command generation and installation helpers.

Provides:
- Command generation based on runtime hints (npx, uvx, docker)
- Environment variable schema extraction
- Config generation for new server installations
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, Any

from .models import (
    McpServerConfig,
    McpRegistryServer,
    PackageInfo,
    EnvVarSchema,
    TransportType,
)

logger = logging.getLogger(__name__)


class McpInstaller:
    """
    Helper for installing MCP servers from registry.
    
    Generates appropriate commands and configurations based on
    package runtime hints and user-provided environment variables.
    """
    
    @staticmethod
    def generate_config(
        server: McpRegistryServer,
        runtime: Optional[str] = None,
        env_values: Optional[Dict[str, str]] = None,
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
        env = env_values or {}
        
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
            metadata={
                "name": server.name,
                "description": server.description,
            }
        )
    
    @staticmethod
    def extract_env_schema(server: McpRegistryServer) -> List[EnvVarSchema]:
        """
        Extract environment variable schema for UI form generation.
        
        Args:
            server: Registry server information
            
        Returns:
            List of environment variable schemas
        """
        return server.environmentVariables
    
    @staticmethod
    def get_available_runtimes(server: McpRegistryServer) -> List[str]:
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
        runtime: Optional[str] = None,
        env_values: Optional[Dict[str, str]] = None,
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
    def _find_package(
        packages: List[PackageInfo], 
        preferred_runtime: Optional[str]
    ) -> Optional[PackageInfo]:
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
    def _generate_command(package: PackageInfo) -> tuple[str, List[str]]:
        """
        Generate command and args for a package.
        
        Returns:
            (command, args) tuple
        """
        runtime = package.runtimeHint or "npx"
        pkg_name = package.name
        
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
    env_vars: Optional[Dict[str, str]] = None,
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


def extract_env_schema(server_data: Dict[str, Any]) -> List[EnvVarSchema]:
    """
    Extract environment variable schema from raw server data.
    
    Args:
        server_data: Raw server data from registry
        
    Returns:
        List of EnvVarSchema
    """
    schemas = []
    for env in server_data.get("environmentVariables", []):
        schemas.append(EnvVarSchema(
            name=env.get("name", ""),
            description=env.get("description"),
            isRequired=env.get("isRequired", False),
            isSecret=env.get("isSecret", False),
            default=env.get("default"),
        ))
    return schemas
