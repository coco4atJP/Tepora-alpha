# backend/src/core/config/service.py
"""
ConfigService - Configuration I/O and Business Logic Layer

This module separates configuration management concerns from the API routes,
providing a clean interface for loading, saving, validating, and manipulating
configuration data.
"""
import copy
import logging
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
import os
import yaml
from pydantic import ValidationError

from .loader import PROJECT_ROOT, SECRETS_PATH, USER_DATA_DIR
from .schema import TeporaSettings

logger = logging.getLogger(__name__)

# Sensitive keys that should be stored in secrets.yaml
SENSITIVE_KEYS = ["api_key", "secret", "password", "token", "credential"]


def _is_sensitive(key: str) -> bool:
    """Check if a key name indicates sensitive data."""
    return any(s in key.lower() for s in SENSITIVE_KEYS)


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
    
    def __init__(self, 
                 config_path: Optional[Path] = None,
                 secrets_path: Optional[Path] = None,
                 user_data_dir: Optional[Path] = None):
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
        """Get the configuration file path using priority logic."""
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
    def secrets_path(self) -> Path:
        """Get the secrets file path."""
        return self._secrets_path
    
    def deep_merge(self, base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
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
    
    def load_config(self) -> Dict[str, Any]:
        """
        Load and merge config.yml and secrets.yaml.
        
        Returns:
            Merged configuration dictionary
        """
        public_config: Dict[str, Any] = {}
        if self.config_path.exists():
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    public_config = yaml.safe_load(f) or {}
            except Exception as e:
                logger.error(f"Failed to load config.yml: {e}")

        secrets_config: Dict[str, Any] = {}
        if self.secrets_path.exists():
            try:
                with open(self.secrets_path, "r", encoding="utf-8") as f:
                    secrets_config = yaml.safe_load(f) or {}
            except Exception as e:
                logger.error(f"Failed to load secrets.yaml: {e}")

        return self.deep_merge(public_config, secrets_config)
    
    def split_config(self, full_config: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """
        Split configuration into public and secrets components.
        
        Args:
            full_config: Complete configuration dictionary
            
        Returns:
            Tuple of (public_config, secrets_config)
        """
        public_config: Dict[str, Any] = {}
        secrets_config: Dict[str, Any] = {}

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
        
        Args:
            new_config: Configuration with potential "****" redacted values
            original_config: Original configuration with real values
            
        Returns:
            Configuration with redacted values restored
        """
        if isinstance(new_config, dict) and isinstance(original_config, dict):
            restored = {}
            for key, value in new_config.items():
                if value == "****":
                    if key in original_config:
                        restored[key] = original_config[key]
                    else:
                        restored[key] = value
                else:
                    if key in original_config:
                        restored[key] = self.restore_redacted_values(value, original_config[key])
                    else:
                        restored[key] = value
            return restored
        elif isinstance(new_config, list) and isinstance(original_config, list):
            restored_list = []
            for i, item in enumerate(new_config):
                orig_item = original_config[i] if i < len(original_config) else None
                if orig_item is not None:
                    restored_list.append(self.restore_redacted_values(item, orig_item))
                else:
                    restored_list.append(item)
            return restored_list
        else:
            return new_config
    
    def validate(self, config: Dict[str, Any]) -> Tuple[bool, Optional[Any]]:
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
    
    def save_config(self, config: Dict[str, Any]) -> None:
        """
        Save configuration, splitting into public and secret files.
        
        Args:
            config: Complete configuration to save
        """
        public_config, secrets_config = self.split_config(config)
        
        # Write public config
        with open(self.config_path, "w", encoding="utf-8") as f:
            yaml.dump(public_config, f, default_flow_style=False, allow_unicode=True)
        
        # Write secrets config
        self.secrets_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.secrets_path, "w", encoding="utf-8") as f:
            yaml.dump(secrets_config, f, default_flow_style=False, allow_unicode=True)
        
        logger.info("Configuration saved successfully (split into config/secrets)")
    
    def update_config(self, config_data: Dict[str, Any], *, merge: bool = False) -> Tuple[bool, Optional[Any]]:
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


# Default instance for convenience (but can be overridden for testing)
_default_service: Optional[ConfigService] = None


def get_config_service() -> ConfigService:
    """Get or create the default ConfigService instance."""
    global _default_service
    if _default_service is None:
        _default_service = ConfigService()
    return _default_service
