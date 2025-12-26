"""
Agent profile configurations.
"""
import logging
from typing import Dict, List, Tuple

from langchain_core.tools import BaseTool

from .loader import settings

logger = logging.getLogger(__name__)

# Cache active profile in memory if set programmatically, otherwise load from config
_active_profile_override: str | None = None

def _get_profiles() -> Dict[str, Dict]:
    """Return dict of all profiles."""
    return {k: v.model_dump() for k, v in settings.agent_profiles.items()}

def get_agent_profile(name: str) -> Dict | None:
    """Return the configuration for a single agent profile."""
    p = settings.agent_profiles.get(name)
    return p.model_dump() if p else None

def get_agent_profile_names() -> List[str]:
    """Return a list of all available agent profile names."""
    return list(settings.agent_profiles.keys())

def iter_agent_profiles() -> List[Tuple[str, Dict]]:
    """Iterate through all (name, profile_config) pairs."""
    return [(k, v.model_dump()) for k, v in settings.agent_profiles.items()]

def get_active_agent_profile_name() -> str:
    """Return the name of the currently active agent profile."""
    if _active_profile_override:
        return _active_profile_override
    # Fallback to config, then default
    return str(settings.active_agent_profile or "default")

def set_active_agent_profile(name: str) -> None:
    """Set the active agent profile by name (runtime only)."""
    global _active_profile_override
    profiles = settings.agent_profiles
    if name not in profiles:
        raise ValueError(f"Profile '{name}' not found. Available: {', '.join(profiles.keys())}")
    _active_profile_override = name
    logger.info("Active agent profile set to: %s", name)

def filter_tools_for_profile(tools: List[BaseTool], profile_name: str) -> List[BaseTool]:
    """Filter a list of tools based on the allow/deny policy of a profile."""
    profile_model = settings.agent_profiles.get(profile_name)
    if not profile_model:
        logger.warning("Profile '%s' not found for tool filtering. Returning all tools.", profile_name)
        return tools

    policy = profile_model.tool_policy
    allow_patterns = policy.allow
    deny_patterns = policy.deny

    if not allow_patterns and not deny_patterns:
        return tools

    allowed_tools = []
    for tool in tools:
        # Check deny list first
        is_denied = any(pattern == tool.name or (pattern.endswith('*') and tool.name.startswith(pattern[:-1])) for pattern in deny_patterns)
        if is_denied:
            continue

        # Check allow list
        is_allowed = any(pattern == '*' or pattern == tool.name or (pattern.endswith('*') and tool.name.startswith(pattern[:-1])) for pattern in allow_patterns)
        if is_allowed:
            allowed_tools.append(tool)

    return allowed_tools