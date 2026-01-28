"""
Custom Agent Registry

Manages registration, retrieval, and tool filtering for user-defined custom agents.
"""

from __future__ import annotations

import fnmatch
import logging
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from langchain_core.tools import BaseTool

from ..config.loader import PROJECT_ROOT, USER_DATA_DIR, settings
from ..config.schema import CustomAgentConfig, CustomAgentToolPolicy

# Security constants for skill loading
# Maximum file size for skill files (1MB)
MAX_SKILL_FILE_SIZE = 1024 * 1024
# Allowed directories for skill files (relative to PROJECT_ROOT or USER_DATA_DIR)
ALLOWED_SKILL_DIRS = ["skills", "custom_skills", "agents"]

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class CustomAgentRegistry:
    """
    Registry for GPTs/Gems-style custom agents.

    Provides:
    - Agent CRUD operations (via settings)
    - Tool filtering based on agent's tool policy
    - Skill loading from markdown files
    """

    _instance: CustomAgentRegistry | None = None
    _initialized: bool

    def __new__(cls) -> CustomAgentRegistry:
        """Singleton pattern."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False  # type: ignore
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        logger.info("CustomAgentRegistry initialized")

    # ========== Agent CRUD Operations ==========

    def get_agent(self, agent_id: str) -> CustomAgentConfig | None:
        """
        Get a custom agent by ID.

        Args:
            agent_id: The agent's unique identifier

        Returns:
            CustomAgentConfig if found, None otherwise
        """
        from typing import cast

        return cast(CustomAgentConfig | None, settings.custom_agents.get(agent_id))

    def list_agents(self, enabled_only: bool = False) -> list[CustomAgentConfig]:
        """
        List all custom agents.

        Args:
            enabled_only: If True, only return enabled agents

        Returns:
            List of CustomAgentConfig objects
        """
        agents = list(settings.custom_agents.values())
        if enabled_only:
            agents = [a for a in agents if a.enabled]
        return agents

    def agent_exists(self, agent_id: str) -> bool:
        """Check if an agent with the given ID exists."""
        return agent_id in settings.custom_agents

    # ========== Tool Filtering ==========

    def get_tool_filter(self, agent_id: str) -> Callable[[list[BaseTool]], list[BaseTool]]:
        """
        Get a tool filter function for the specified agent.

        Args:
            agent_id: The agent's ID

        Returns:
            A function that filters tools based on the agent's policy
        """
        agent = self.get_agent(agent_id)
        if not agent:
            # No agent found, return pass-through filter
            return lambda tools: tools

        return lambda tools: self._filter_tools(tools, agent.tool_policy)

    def _filter_tools(self, tools: list[BaseTool], policy: CustomAgentToolPolicy) -> list[BaseTool]:
        """
        Filter tools based on the agent's tool policy.

        Priority: denied_tools > allowed_tools

        Args:
            tools: List of available tools
            policy: The agent's tool policy

        Returns:
            Filtered list of tools
        """
        filtered = []

        for tool in tools:
            tool_name = tool.name

            # Check denied list first (highest priority)
            if self._matches_pattern_list(tool_name, policy.denied_tools):
                logger.debug("Tool '%s' denied by policy", tool_name)
                continue

            # Check allowed list
            if self._matches_pattern_list(tool_name, policy.allowed_tools):
                filtered.append(tool)
            else:
                logger.debug("Tool '%s' not in allowed list", tool_name)

        return filtered

    def _matches_pattern_list(self, tool_name: str, patterns: list[str]) -> bool:
        """
        Check if a tool name matches any pattern in the list.

        Supports glob patterns (* for wildcard).

        Args:
            tool_name: The tool name to check
            patterns: List of patterns to match against

        Returns:
            True if the tool matches any pattern
        """
        for pattern in patterns:
            if pattern == "*":
                return True
            if fnmatch.fnmatch(tool_name, pattern):
                return True
        return False

    def requires_confirmation(self, agent_id: str, tool_name: str) -> bool:
        """
        Check if a tool requires confirmation for the given agent.

        Args:
            agent_id: The agent's ID
            tool_name: The tool name to check

        Returns:
            True if the tool requires confirmation
        """
        agent = self.get_agent(agent_id)
        if not agent:
            return False

        return self._matches_pattern_list(tool_name, agent.tool_policy.require_confirmation)

    # ========== Skill Loading ==========

    def _get_allowed_skill_roots(self) -> list[Path]:
        """
        Get the list of allowed root directories for skill files.

        Returns:
            List of Path objects representing allowed skill directories
        """
        allowed_roots: list[Path] = []

        for dir_name in ALLOWED_SKILL_DIRS:
            # Add PROJECT_ROOT based paths
            allowed_roots.append(PROJECT_ROOT / dir_name)
            # Add USER_DATA_DIR based paths
            allowed_roots.append(USER_DATA_DIR / dir_name)

        return allowed_roots

    def _is_path_allowed(self, skill_path: Path) -> tuple[bool, str]:
        """
        Validate that a skill path is within allowed directories.

        Args:
            skill_path: The path to validate

        Returns:
            Tuple of (is_allowed: bool, reason: str)
        """
        try:
            # Resolve the path to prevent path traversal attacks
            resolved = skill_path.resolve()
        except (ValueError, OSError) as e:
            return False, f"Invalid path: {e}"

        # Check against allowed roots
        allowed_roots = self._get_allowed_skill_roots()
        for root in allowed_roots:
            try:
                root_resolved = root.resolve()
                # Check if the resolved path is within the allowed root
                resolved.relative_to(root_resolved)
                return True, "Path is within allowed directory"
            except ValueError:
                # relative_to raises ValueError if path is not relative to root
                continue

        # Path is not within any allowed directory
        allowed_dirs = ", ".join(str(r) for r in allowed_roots)
        return False, f"Path is outside allowed directories: {allowed_dirs}"

    def _validate_skill_file(self, skill_path: Path) -> tuple[bool, str]:
        """
        Validate a skill file for security.

        Args:
            skill_path: The path to validate

        Returns:
            Tuple of (is_valid: bool, reason: str)
        """
        # Check if path is allowed
        is_allowed, reason = self._is_path_allowed(skill_path)
        if not is_allowed:
            return False, reason

        try:
            resolved = skill_path.resolve()

            # Check file exists
            if not resolved.exists():
                return False, "File does not exist"

            # Check it's a file, not a directory
            if not resolved.is_file():
                return False, "Path is not a file"

            # Check file size
            file_size = resolved.stat().st_size
            if file_size > MAX_SKILL_FILE_SIZE:
                return False, f"File too large: {file_size} bytes (max: {MAX_SKILL_FILE_SIZE})"

            # Validate file extension (only .md, .txt, .skill allowed)
            allowed_extensions = {".md", ".txt", ".skill"}
            if resolved.suffix.lower() not in allowed_extensions:
                return (
                    False,
                    f"Invalid file extension: {resolved.suffix} (allowed: {allowed_extensions})",
                )

            return True, "File is valid"
        except (OSError, ValueError) as e:
            return False, f"Error validating file: {e}"

    def load_skills(self, agent_id: str) -> list[str]:
        """
        Load skill content from the agent's skill files.

        Security measures:
        - Only allows files within PROJECT_ROOT/skills/ or USER_DATA_DIR/skills/
        - Prevents path traversal attacks using path resolution
        - Limits file size to MAX_SKILL_FILE_SIZE
        - Only allows .md, .txt, .skill extensions

        Args:
            agent_id: The agent's ID

        Returns:
            List of skill content strings (markdown)
        """
        agent = self.get_agent(agent_id)
        if not agent or not agent.skills:
            return []

        skills_content: list[str] = []

        for skill_path_str in agent.skills:
            skill_path = Path(skill_path_str)

            # Validate the skill file
            is_valid, reason = self._validate_skill_file(skill_path)
            if not is_valid:
                logger.warning(
                    "Skill file rejected for agent '%s': %s - %s",
                    agent_id,
                    skill_path_str,
                    reason,
                )
                continue

            try:
                resolved_path = skill_path.resolve()
                with open(resolved_path, encoding="utf-8") as f:
                    content = f.read()
                    skills_content.append(content)
                    logger.debug("Loaded skill from: %s", resolved_path)
            except FileNotFoundError:
                logger.warning("Skill file not found: %s", skill_path_str)
            except UnicodeDecodeError as e:
                logger.error("Skill file encoding error %s: %s", skill_path_str, e)
            except Exception as e:
                logger.error("Error loading skill %s: %s", skill_path_str, e)

        return skills_content

    def get_skills_as_prompt(self, agent_id: str) -> str:
        """
        Get all skills formatted as a prompt section.

        Args:
            agent_id: The agent's ID

        Returns:
            Formatted string with all skill content
        """
        skills = self.load_skills(agent_id)
        if not skills:
            return ""

        sections = []
        for i, skill in enumerate(skills, 1):
            sections.append(f"<skill_{i}>\n{skill}\n</skill_{i}>")

        return "<skills>\n" + "\n".join(sections) + "\n</skills>"


# Singleton instance
custom_agent_registry = CustomAgentRegistry()
