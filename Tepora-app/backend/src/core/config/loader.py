# agent_core/config/loader.py
import logging
import os
import sys
from pathlib import Path
from typing import Any

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
    env_root = os.getenv("TEPORA_ROOT")
    if env_root:
        return Path(env_root).resolve()

    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)

    current = Path(__file__).resolve().parent
    for _ in range(10):  # Max 10 levels up to prevent infinite loop
        if (current / "pyproject.toml").exists():
            return current
        if current.parent == current:
            break
        current = current.parent

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
    return getattr(sys, "frozen", False)


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
    logger.warning("Failed to create user directories: %s", e, exc_info=True)


class YamlConfigSettingsSource(PydanticBaseSettingsSource):
    """
    A settings source that loads values from a YAML file.
    """

    def __init__(self, settings_cls: type[BaseSettings], yaml_path: Path):
        super().__init__(settings_cls)
        self.yaml_path = yaml_path

    def get_field_value(self, field: Any, field_name: str) -> tuple[Any, str, bool]:
        # Not used when returning the whole dict from __call__
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        if not self.yaml_path.exists():
            return {}
        try:
            with open(self.yaml_path, encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception as e:
            logger.error(
                "Failed to load YAML config from %s: %s",
                self.yaml_path,
                e,
                exc_info=True,
            )
            return {}

        if not isinstance(data, dict):
            logger.warning(
                "Ignoring YAML config at %s: expected mapping, got %s",
                self.yaml_path,
                type(data).__name__,
            )
            return {}

        return data


class ConfigManager:
    _instance = None
    _settings: TeporaSettings | None = None
    _initialized = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def load_config(self, force_reload: bool = False) -> None:
        """
        Load configuration using Pydantic Settings.
        """
        if self._initialized and not force_reload:
            return

        # Determine config path
        # Priority:

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
                settings_cls: type[BaseSettings],
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
            logger.info(
                "Settings initialized. Priority: Env > .env > Secrets (%s) > YAML (%s) > Defaults",
                SECRETS_PATH,
                config_path,
            )
        except Exception as e:
            logger.error("Failed to validate settings: %s", e, exc_info=True)
            self._settings = TeporaSettings()

        self._initialized = True

    @property
    def settings(self) -> TeporaSettings:
        if not self._initialized or self._settings is None:
            self.load_config()
        if self._settings is None:
            raise RuntimeError("Settings not loaded")
        return self._settings


# Singleton Instance
config_manager = ConfigManager()


class SettingsProxy:
    def __getattr__(self, name):
        return getattr(config_manager.settings, name)


settings = SettingsProxy()


# --- Session Token (for WebSocket Security) ---
# Deprecated: Use src.tepora_server.api.security.get_session_token instead
# This function is kept for backwards compatibility


def get_session_token() -> str | None:
    """
    Get the session token for WebSocket authentication.

    .. deprecated::
        Use ``src.tepora_server.api.security.get_session_token`` instead.
        This function is maintained for backwards compatibility only.
    """
    try:
        from src.tepora_server.api.security import get_session_token as _get_token

        return _get_token()
    except ImportError:
        # Fallback for cases where security module is not available
        import secrets

        return secrets.token_urlsafe(32)
