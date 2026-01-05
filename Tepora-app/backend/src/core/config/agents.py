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
    Return dict of all profiles (merged characters and professionals).
    If a key exists in both, character takes precedence (though keys should ideally be unique).
    """
    profiles = {}
    if settings.professionals:
        profiles.update({k: v.model_dump() for k, v in settings.professionals.items()})
    if settings.characters:
        profiles.update({k: v.model_dump() for k, v in settings.characters.items()})
    return profiles


def get_agent_profile(name: str) -> dict | None:
    """Return the configuration for a single agent profile (Character or Professional)."""
    # Try Character first
    char = settings.characters.get(name)
    if char:
        return char.model_dump()

    # Then Professional
    prof = settings.professionals.get(name)
    if prof:
        return prof.model_dump()

    return None


def get_agent_profile_names() -> list[str]:
    """Return a list of all available agent profile names."""
    keys = set()
    if settings.characters:
        keys.update(settings.characters.keys())
    if settings.professionals:
        keys.update(settings.professionals.keys())
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
        settings.professionals and name in settings.professionals
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
    - Characters: Access to all tools (default behavior for now).
    - Professionals: Access ONLY to tools listed in 'tools' config.
    """
    # Check Professional first (strict tool usage)
    prof = settings.professionals.get(profile_name) if settings.professionals else None
    if prof:
        allowed_names = set(prof.tools)
        return [tool for tool in tools if tool.name in allowed_names]

    # Check Character
    char = settings.characters.get(profile_name) if settings.characters else None
    if char:
        # Characters generally delegate to professionals or use basic tools.
        # For legacy compatibility, we allow all tools for characters unless we define a policy.
        # Future: Add allow/deny lists to CharacterConfig if needed.
        return tools

    # Profile not found? Log warning and return empty or all?
    # Safer to return all for backward compat during migration, or empty for security.
    # Given we removed 'agent_profiles', let's return all to avoid breaking everything if key is missing.
    logger.warning("Profile '%s' not found for tool filtering. Returning all tools.", profile_name)
    return tools
