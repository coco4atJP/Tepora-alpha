# backend/src/core/config/service.py
"""
ConfigService - Configuration I/O and Business Logic Layer

This module separates configuration management concerns from the API routes,
providing a clean interface for loading, saving, validating, and manipulating
configuration data.
"""

import copy
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from .loader import PROJECT_ROOT, SECRETS_PATH, USER_DATA_DIR
from .schema import AppConfig, CustomAgentConfig, TeporaSettings

logger = logging.getLogger(__name__)


def _get_sensitive_patterns() -> list[str]:
    """Get sensitive key patterns from config schema."""
    return AppConfig().sensitive_key_patterns


def _get_sensitive_whitelist() -> list[str]:
    """Get whitelist for keys that should NOT be treated as sensitive."""
    return AppConfig().sensitive_key_whitelist


def _is_sensitive(key: str) -> bool:
    """Check if a key name indicates sensitive data.

    Uses pattern matching but respects a whitelist to avoid false positives
    on keys like 'max_tokens' which contain 'token' but are not secrets.
    """
    key_lower = key.lower()

    # Check whitelist first - exact match takes precedence
    whitelist = _get_sensitive_whitelist()
    if key_lower in whitelist:
        return False

    # Check against sensitive patterns
    patterns = _get_sensitive_patterns()
    return any(pattern in key_lower for pattern in patterns)


class ConfigService:
    """
    Service class for configuration management.

    Handles:
    - Loading configuration from config.yml and secrets.yaml
    - Deep merging configuration dictionaries
    - Splitting configuration into public and secret parts
    - Redacting sensitive values for API responses
    - Restoring redacted values during updates
    - Validating configuration against Pydantic schema
    - Saving configuration to appropriate files
    """

    def __init__(
        self,
        config_path: Path | None = None,
        secrets_path: Path | None = None,
        user_data_dir: Path | None = None,
    ):
        """
        Initialize ConfigService with optional path overrides.

        Args:
            config_path: Override for config.yml location
            secrets_path: Override for secrets.yaml location
            user_data_dir: Override for user data directory
        """
        self._user_data_dir = user_data_dir or USER_DATA_DIR
        self._secrets_path = secrets_path or SECRETS_PATH
        self._config_path_override = config_path

    @property
    def config_path(self) -> Path:
        """Get the configuration file path for *reading* using priority logic."""
        if self._config_path_override:
            return self._config_path_override

        env_config = os.getenv("TEPORA_CONFIG_PATH")
        if env_config:
            return Path(env_config)

        user_config = self._user_data_dir / "config.yml"
        if user_config.exists():
            return user_config
        return PROJECT_ROOT / "config.yml"

    @property
    def config_write_path(self) -> Path:
        """Get the configuration file path for *writing*.

        In packaged (frozen) environments, PROJECT_ROOT may point to an extracted bundle
        directory (e.g. PyInstaller `_MEIPASS`) which is non-persistent across launches.
        Writes should default to USER_DATA_DIR to ensure settings persist.
        """
        if self._config_path_override:
            return self._config_path_override

        env_config = os.getenv("TEPORA_CONFIG_PATH")
        if env_config:
            return Path(env_config)

        return self._user_data_dir / "config.yml"

    @property
    def secrets_path(self) -> Path:
        """Get the secrets file path."""
        return self._secrets_path

    def deep_merge(self, base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
        """
        Deep merge two dictionaries. Override values take precedence.

        Args:
            base: Base dictionary
            override: Dictionary with values to override

        Returns:
            Merged dictionary (new copy)
        """
        result = copy.deepcopy(base)
        for k, v in override.items():
            if k in result and isinstance(result[k], dict) and isinstance(v, dict):
                result[k] = self.deep_merge(result[k], v)
            else:
                result[k] = copy.deepcopy(v)
        return result

    def load_config(self) -> dict[str, Any]:
        """
        Load and merge config.yml and secrets.yaml.

        Returns:
            Merged configuration dictionary
        """
        public_config = self._load_yaml_file(self.config_path, label="config.yml")
        secrets_config = self._load_yaml_file(self.secrets_path, label="secrets.yaml")

        merged = self.deep_merge(public_config, secrets_config)

        # Apply defaults for characters if missing or empty
        from .schema import DEFAULT_CHARACTERS

        if not merged.get("characters"):
            merged["characters"] = {
                k: c.model_dump() if hasattr(c, "model_dump") else dict(c)
                for k, c in DEFAULT_CHARACTERS.items()
            }

        return merged

    @staticmethod
    def _load_yaml_file(path: Path, *, label: str) -> dict[str, Any]:
        if not path.exists():
            return {}

        try:
            with open(path, encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception as e:
            logger.error("Failed to load %s: %s", label, e, exc_info=True)
            return {}

        if not isinstance(data, dict):
            logger.warning("Ignoring %s: expected mapping, got %s", label, type(data).__name__)
            return {}

        return data

    def split_config(self, full_config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        """
        Split configuration into public and secrets components.

        Args:
            full_config: Complete configuration dictionary

        Returns:
            Tuple of (public_config, secrets_config)
        """
        public_config: dict[str, Any] = {}
        secrets_config: dict[str, Any] = {}

        for key, value in full_config.items():
            if isinstance(value, dict):
                p_sub, s_sub = self.split_config(value)
                if p_sub:
                    public_config[key] = p_sub
                if s_sub:
                    secrets_config[key] = s_sub
            else:
                if _is_sensitive(key) and value is not None:
                    secrets_config[key] = value
                else:
                    public_config[key] = value

        return public_config, secrets_config

    def redact_sensitive_values(self, obj: Any) -> Any:
        """
        Recursively redact sensitive values in a configuration dictionary.

        Args:
            obj: Configuration object to redact

        Returns:
            Redacted configuration
        """
        if isinstance(obj, dict):
            redacted = {}
            for key, value in obj.items():
                if _is_sensitive(key) and value is not None:
                    redacted[key] = "****"
                else:
                    redacted[key] = self.redact_sensitive_values(value)
            return redacted
        elif isinstance(obj, list):
            return [self.redact_sensitive_values(item) for item in obj]
        else:
            return obj

    def restore_redacted_values(self, new_config: Any, original_config: Any) -> Any:
        """
        Restore redacted values ("****") from original configuration.

        Notes:
        - Redaction placeholders should never be persisted back to disk.
        - If a placeholder cannot be restored (e.g., the original config did not
          contain that key because it relied on defaults), we drop that key so
          validation/defaults can apply instead of failing (e.g., int fields like
          chat_history.max_tokens).

        Args:
            new_config: Configuration with potential "****" redacted values
            original_config: Original configuration with real values

        Returns:
            Configuration with redacted values restored
        """
        if isinstance(new_config, dict):
            restored: dict[str, Any] = {}
            orig_dict: dict[str, Any] | None = (
                original_config if isinstance(original_config, dict) else None
            )

            for key, value in new_config.items():
                has_orig = orig_dict is not None and key in orig_dict
                orig_value = orig_dict.get(key) if orig_dict else None

                if value == "****":
                    if has_orig:
                        restored[key] = orig_value
                    else:
                        # No original value to restore from (likely a default-only key).
                        # Drop it to avoid persisting placeholders and failing validation.
                        continue
                elif isinstance(value, (dict, list)):
                    restored[key] = self.restore_redacted_values(value, orig_value)
                else:
                    restored[key] = value

            return restored

        if isinstance(new_config, list):
            restored_list: list[Any] = []
            orig_list: list[Any] | None = (
                original_config if isinstance(original_config, list) else None
            )

            for i, item in enumerate(new_config):
                orig_item = orig_list[i] if orig_list is not None and i < len(orig_list) else None

                if item == "****":
                    if orig_list is not None and i < len(orig_list):
                        restored_list.append(orig_item)
                    else:
                        # Drop non-restorable placeholder items.
                        continue
                elif isinstance(item, (dict, list)):
                    restored_list.append(self.restore_redacted_values(item, orig_item))
                else:
                    restored_list.append(item)

            return restored_list

        return new_config

    def validate(self, config: dict[str, Any]) -> tuple[bool, Any | None]:
        """
        Validate configuration against Pydantic schema.

        Args:
            config: Configuration dictionary to validate

        Returns:
            Tuple of (is_valid, error_details)
        """
        try:
            TeporaSettings(**config)
            return True, None
        except ValidationError as ve:
            return False, ve.errors()

    def save_config(self, config: dict[str, Any]) -> None:
        """
        Save configuration, splitting into public and secret files.

        Args:
            config: Complete configuration to save
        """
        public_config, secrets_config = self.split_config(config)

        # Write public config
        config_path = self.config_write_path
        config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(public_config, f, default_flow_style=False, allow_unicode=True)

        # Write secrets config
        self.secrets_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.secrets_path, "w", encoding="utf-8") as f:
            yaml.dump(secrets_config, f, default_flow_style=False, allow_unicode=True)

        logger.info("Configuration saved successfully (split into config/secrets)")

    def update_config(
        self, config_data: dict[str, Any], *, merge: bool = False
    ) -> tuple[bool, Any | None]:
        """
        Update configuration with validation and proper handling of redacted values.

        Args:
            config_data: New configuration data
            merge: If True, merge with existing config (PATCH). If False, replace (POST).

        Returns:
            Tuple of (success, error_details)
        """
        current_config = self.load_config()

        # Restore redacted values
        config_to_save = self.restore_redacted_values(config_data, current_config)

        if merge:
            config_to_save = self.deep_merge(current_config, config_to_save)

        # Validate
        is_valid, errors = self.validate(config_to_save)
        if not is_valid:
            return False, errors

        # Save
        self.save_config(config_to_save)
        return True, None

    # -------------------------------------------------------------------------
    # Custom Agent Management
    # -------------------------------------------------------------------------

    def list_custom_agents(self, enabled_only: bool = False) -> list[dict[str, Any]]:
        """List all custom agents."""
        config = self.load_config()
        # Ensure we're accessing the dictionary structure correctly
        # Note: load_config returns a dict, but 'custom_agents' values might be dicts (if loaded from yaml)
        # or Pydantic models (if default applied via Schema and then dumped?)
        # load_config returns pure dicts from YAML + defaults applied.
        custom_agents = config.get("custom_agents", {})

        # Depending on how defaults are applied, custom_agents might be empty or populated.
        # We need to handle potential inconsistency if Schema defaults weren't fully materialized in dict form
        # but load_config logic does 'merged = ...' so it should be dicts.

        agents = []
        for agent_data in custom_agents.values():
            if enabled_only and not agent_data.get("enabled", True):
                continue
            agents.append(agent_data)

        return agents

    def get_custom_agent(self, agent_id: str) -> dict[str, Any] | None:
        """Get a single custom agent by ID."""
        config = self.load_config()
        return config.get("custom_agents", {}).get(agent_id)

    def create_custom_agent(self, agent_data: dict[str, Any]) -> tuple[bool, dict[str, Any] | str]:
        """
        Create a new custom agent.

        Returns:
            Tuple (success, created_agent_dict_or_error_message)
        """
        # Validate required fields
        if not agent_data.get("id"):
            return False, "Agent ID is required"
        if not agent_data.get("name"):
            return False, "Agent name is required"
        if not agent_data.get("system_prompt"):
            return False, "System prompt is required"

        agent_id = agent_data["id"]

        current_config = self.load_config()
        custom_agents = current_config.get("custom_agents", {})

        if agent_id in custom_agents:
            return False, "Agent ID already exists"

        # Add timestamps
        now = datetime.now(UTC).isoformat()
        agent_data["created_at"] = now
        agent_data["updated_at"] = now

        # Validate with Pydantic
        try:
            agent = CustomAgentConfig(**agent_data)
        except Exception as e:
            logger.warning("Custom agent validation failed in create: %s", e)
            return False, f"Invalid agent data: {e}"

        # Update config
        custom_agents[agent_id] = agent.model_dump()
        success, errors = self.update_config({"custom_agents": custom_agents}, merge=True)

        if not success:
            return False, f"Failed to save agent: {errors}"

        return True, agent.model_dump()

    def update_custom_agent(self, agent_id: str, agent_data: dict[str, Any]) -> tuple[bool, dict[str, Any] | str]:
        """Update an existing custom agent."""
        current_config = self.load_config()
        custom_agents = current_config.get("custom_agents", {})

        if agent_id not in custom_agents:
            return False, "Agent not found"

        # Merge with existing data
        existing = custom_agents[agent_id]
        updated_data = {**existing, **agent_data}
        updated_data["id"] = agent_id  # Ensure ID cannot be changed
        updated_data["updated_at"] = datetime.now(UTC).isoformat()

        # Validate with Pydantic
        try:
            agent = CustomAgentConfig(**updated_data)
        except Exception as e:
            logger.warning("Custom agent validation failed in update: %s", e)
            return False, f"Invalid agent data: {e}"

        # Update config
        custom_agents[agent_id] = agent.model_dump()
        success, errors = self.update_config({"custom_agents": custom_agents}, merge=True)

        if not success:
            return False, f"Failed to save agent: {errors}"

        return True, agent.model_dump()

    def delete_custom_agent(self, agent_id: str) -> tuple[bool, str | None]:
        """Delete a custom agent."""
        current_config = self.load_config()
        custom_agents = current_config.get("custom_agents", {})

        if agent_id not in custom_agents:
            return False, "Agent not found"

        del custom_agents[agent_id]

        # Use merge=False with the full updated config to ensure the key removal persists
        # (deep_merge used in merge=True is additive and won't remove missing keys)
        success, errors = self.update_config(current_config, merge=False)

        if not success:
            return False, f"Failed to delete agent: {errors}"

        return True, None


# Default instance for convenience (but can be overridden for testing)
_default_service: ConfigService | None = None


def get_config_service() -> ConfigService:
    """Get or create the default ConfigService instance."""
    global _default_service
    if _default_service is None:
        _default_service = ConfigService()
    return _default_service
