# agent_core/config/loader.py
import logging
import os
import secrets
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, Type

import yaml
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource

from .schema import TeporaSettings

logger = logging.getLogger(__name__)

def _find_project_root() -> Path:
    """
    Deterministically find the project root.
    Priority:
    1. TEPORA_ROOT environment variable.
    2. PyInstaller _MEIPASS.
    3. Search for pyproject.toml from current file upwards.
    4. Fixed relative path from this file (fallback).
    """
    # 1. Environment Variable Override
    env_root = os.getenv("TEPORA_ROOT")
    if env_root:
        return Path(env_root).resolve()

    # 2. Frozen/PyInstaller environment
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return Path(sys._MEIPASS)

    # 3. Search for pyproject.toml from this file upwards (robust method)
    current = Path(__file__).resolve().parent
    for _ in range(10):  # Max 10 levels up to prevent infinite loop
        if (current / "pyproject.toml").exists():
            return current
        if current.parent == current:
            break
        current = current.parent

    # 4. Fixed relative path fallback (src/core/config/loader.py -> backend)
    # backend/src/core/config/loader.py -> parents[3] is backend
    try:
        relative_root = Path(__file__).resolve().parents[3]
        return relative_root
    except (IndexError, ValueError):
        return Path.cwd()

PROJECT_ROOT = _find_project_root()
MODEL_BASE_PATH = os.getenv("MODEL_BASE_PATH", str(PROJECT_ROOT))

# Load environment variables from .env file
load_dotenv(dotenv_path=PROJECT_ROOT / ".env")


def is_frozen() -> bool:
    """PyInstaller/Tauri Sidecar環境かどうかを判定"""
    return getattr(sys, 'frozen', False)


def get_user_data_dir() -> Path:
    """ユーザーデータディレクトリを取得"""
    if not is_frozen():
        return PROJECT_ROOT
    
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        return Path(base) / "Tepora"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Tepora"
    else:
        xdg_data = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
        return Path(xdg_data) / "tepora"



USER_DATA_DIR = get_user_data_dir()
LOG_DIR = USER_DATA_DIR / "logs"
DB_PATH = USER_DATA_DIR / "tepora_chat.db"
CHROMA_DB_PATH = USER_DATA_DIR / "chroma_db"
SECRETS_PATH = USER_DATA_DIR / "secrets.yaml"

# Ensure directories exist
try:
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    CHROMA_DB_PATH.mkdir(parents=True, exist_ok=True)
except Exception as e:
    # If we can't create them (e.g. permissions), we log to stdout but continue
    logger.warning(f"Failed to create user directories: {e}")

class YamlConfigSettingsSource(PydanticBaseSettingsSource):
    """
    A settings source that loads values from a YAML file.
    """
    def __init__(self, settings_cls: Type[BaseSettings], yaml_path: Path):
        super().__init__(settings_cls)
        self.yaml_path = yaml_path

    def get_field_value(self, field: Any, field_name: str) -> Tuple[Any, str, bool]:
        # Not used when returning the whole dict from __call__
        return None, field_name, False

    def __call__(self) -> Dict[str, Any]:
        if not self.yaml_path.exists():
            return {}
        try:
            with open(self.yaml_path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.error(f"Failed to load YAML config from {self.yaml_path}: {e}")
            return {}

class ConfigManager:
    _instance = None
    _settings: Optional[TeporaSettings] = None
    _initialized = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(ConfigManager, cls).__new__(cls)
        return cls._instance

    def load_config(self, force_reload: bool = False) -> None:
        """
        Load configuration using Pydantic Settings.
        """
        if self._initialized and not force_reload:
            return

        # Determine config path
        # Priority:
        # 1. TEPORA_CONFIG_PATH env var
        # 2. USER_DATA_DIR / config.yml
        # 3. PROJECT_ROOT / config.yml (Fallback)
        
        env_config = os.getenv("TEPORA_CONFIG_PATH")
        if env_config:
            config_path = Path(env_config)
        else:
            user_config = USER_DATA_DIR / "config.yml"
            if user_config.exists():
                config_path = user_config
            else:
                config_path = PROJECT_ROOT / "config.yml"
        
        # Subclass TeporaSettings to inject the YAML source dynamically
        class LoadedTeporaSettings(TeporaSettings):
            @classmethod
            def settings_customise_sources(
                cls,
                settings_cls: Type[BaseSettings],
                init_settings: PydanticBaseSettingsSource,
                env_settings: PydanticBaseSettingsSource,
                dotenv_settings: PydanticBaseSettingsSource,
                file_secret_settings: PydanticBaseSettingsSource,
            ) -> tuple[PydanticBaseSettingsSource, ...]:
                return (
                    init_settings,
                    env_settings,
                    dotenv_settings,
                    YamlConfigSettingsSource(settings_cls, SECRETS_PATH),
                    YamlConfigSettingsSource(settings_cls, config_path),
                    file_secret_settings,
                )

        try:
            self._settings = LoadedTeporaSettings()
            logger.info(f"Settings initialized. Priority: Env > .env > Secrets ({SECRETS_PATH}) > YAML ({config_path}) > Defaults")
        except Exception as e:
            logger.error(f"Failed to validate settings: {e}", exc_info=True)
            self._settings = TeporaSettings()

        self._initialized = True

    @property
    def settings(self) -> TeporaSettings:
        if not self._initialized or self._settings is None:
            self.load_config()
        return self._settings

# Singleton Instance
config_manager = ConfigManager()

class SettingsProxy:
    def __getattr__(self, name):
        return getattr(config_manager.settings, name)

settings = SettingsProxy()


# --- Session Token (for WebSocket Security) ---

_session_token: Optional[str] = None

def get_session_token() -> str:
    """
    Get the session token generated at startup.
    
    This token is used for WebSocket authentication to ensure only
    the local frontend can connect to the backend.
    
    Returns:
        A cryptographically secure random token (32 bytes, URL-safe base64)
    """
    global _session_token
    if _session_token is None:
        _session_token = secrets.token_urlsafe(32)
        logger.info("Session token generated for WebSocket authentication")
    return _session_token

