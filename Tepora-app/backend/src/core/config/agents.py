"""
Agent profile configurations.
"""

import logging
from typing import Any

from langchain_core.tools import BaseTool

from .loader import settings

logger = logging.getLogger(__name__)

# Cache active profile in memory if set programmatically, otherwise load from config
_active_profile_override: str | None = None


def _get_profiles() -> dict[str, Any]:
    """
    Return dict of all profiles (merged characters and custom agents).
    If a key exists in both, character takes precedence (though keys should ideally be unique).
    """
    profiles = {}
    if settings.custom_agents:
        profiles.update({k: v.model_dump() for k, v in settings.custom_agents.items()})
    if settings.characters:
        profiles.update({k: v.model_dump() for k, v in settings.characters.items()})
    return profiles


def get_agent_profile(name: str) -> dict | None:
    """Return the configuration for a single agent profile (Character or Custom Agent)."""
    # Try Character first
    char = settings.characters.get(name)
    if char:
        return dict(char.model_dump())

    # Then Custom Agent
    agent = settings.custom_agents.get(name)
    if agent:
        return dict(agent.model_dump())

    return None


def get_agent_profile_names() -> list[str]:
    """Return a list of all available agent profile names."""
    keys = set()
    if settings.characters:
        keys.update(settings.characters.keys())
    if settings.custom_agents:
        keys.update(settings.custom_agents.keys())
    return list(keys)


def iter_agent_profiles() -> list[tuple[str, dict]]:
    """Iterate through all (name, profile_config) pairs."""
    return list(_get_profiles().items())


def get_active_agent_profile_name() -> str:
    """Return the name of the currently active agent profile."""
    if _active_profile_override:
        return _active_profile_override
    # Fallback to config, then default
    return str(settings.active_agent_profile or "default")


def set_active_agent_profile(name: str) -> None:
    """Set the active agent profile by name (runtime only)."""
    global _active_profile_override

    # Check if exists in either
    if (settings.characters and name in settings.characters) or (
        settings.custom_agents and name in settings.custom_agents
    ):
        _active_profile_override = name
        logger.info("Active agent profile set to: %s", name)
    else:
        # Get all valid keys for error message
        valid_keys = get_agent_profile_names()
        raise ValueError(f"Profile '{name}' not found. Available: {', '.join(valid_keys)}")


def filter_tools_for_profile(tools: list[BaseTool], profile_name: str) -> list[BaseTool]:
    """
    Filter a list of tools based on the profile type.
    - Characters: Access to all tools (default behavior).
    - Custom Agents: Follow tool_policy.
    """
    # Check Custom Agent
    agent = settings.custom_agents.get(profile_name) if settings.custom_agents else None
    if agent and agent.tool_policy:
        allowed = set(agent.tool_policy.allowed_tools)
        denied = set(agent.tool_policy.denied_tools)

        filtered = []
        for tool in tools:
            # Deny list takes precedence
            if tool.name in denied:
                continue

            # Allow list ('*' means all)
            if '*' in allowed or tool.name in allowed:
                filtered.append(tool)

        return filtered

    # Check Character (or fallback)
    char = settings.characters.get(profile_name) if settings.characters else None
    if char:
        # Characters typically have access to all tools unless restricted in future
        return tools

    # Profile not found
    logger.warning("Profile '%s' not found for tool filtering. Returning all tools.", profile_name)
    return tools
