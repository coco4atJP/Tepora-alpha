from __future__ import annotations

import json
import logging
from pathlib import Path

from src.core import config as core_config

logger = logging.getLogger(__name__)


def resolve_path_in_user_data_dir(path_str: str) -> Path:
    """
    Resolve a configured path.

    - Absolute path: use as-is
    - Relative path: resolve relative to USER_DATA_DIR (not PROJECT_ROOT)
    """
    path = Path(path_str)
    if path.is_absolute():
        return path
    return core_config.USER_DATA_DIR / path


def resolve_mcp_config_path() -> Path:
    """Resolve MCP tools config path from settings (USER_DATA_DIR-relative)."""
    return resolve_path_in_user_data_dir(core_config.settings.app.mcp_config_path)


def resolve_mcp_policy_path(*, config_path: Path | None = None) -> Path:
    """
    Resolve MCP policy path.

    Keep policy alongside the tools config so trust/policy stay together.
    """
    base = config_path or resolve_mcp_config_path()
    return base.parent / "mcp_policy.json"


def ensure_mcp_config_exists(config_path: Path) -> None:
    """
    Ensure the MCP tools config exists in a writable location.

    - Creates parent directory
    - If missing, seeds from PROJECT_ROOT/config if available, otherwise creates an empty config
    """
    try:
        config_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to create MCP config directory %s: %s", config_path.parent, exc)
        return

    if config_path.exists():
        return

    default_path = core_config.PROJECT_ROOT / "config" / "mcp_tools_config.json"
    try:
        if default_path.exists():
            config_path.write_text(default_path.read_text(encoding="utf-8"), encoding="utf-8")
            return
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to seed MCP config from %s to %s: %s", default_path, config_path, exc
        )

    try:
        config_path.write_text(
            json.dumps({"mcpServers": {}}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to create default MCP config at %s: %s", config_path, exc)
