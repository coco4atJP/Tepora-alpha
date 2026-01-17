import logging
import os
import signal
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from src.core.common.security import SecurityUtils
from src.core.config.loader import LOG_DIR
from src.core.config.schema import TeporaSettings
from src.core.config.service import get_config_service
from src.tepora_server.api.dependencies import AppState, get_app_state
from src.tepora_server.api.security import get_api_key

logger = logging.getLogger("tepora.server.api")
router = APIRouter()


def _get_log_dir() -> Path:
    """Ensure log directory exists and return path."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return LOG_DIR


def _reload_config_manager() -> None:
    try:
        from src.core.config.loader import config_manager

        config_manager.load_config(force_reload=True)
    except Exception as e:
        logger.debug("Failed to reload config manager: %s", e, exc_info=True)


# --- Routes ---


@router.get("/health")
async def health_check(state: AppState = Depends(get_app_state)):
    return {"status": "ok", "initialized": state.core.initialized}


@router.post("/api/shutdown", dependencies=[Depends(get_api_key)])
async def shutdown_server():
    """Gracefully shutdown the server by sending SIGTERM to self."""
    logger.info("Shutdown requested via API")
    # SIGTERMを自分自身に送信してUvicornを終了
    os.kill(os.getpid(), signal.SIGTERM)
    return {"status": "shutting_down"}


# /api/personas removed (deprecated)


@router.get("/api/status")
async def get_status(state: AppState = Depends(get_app_state)):
    """Get system status information."""
    try:
        # Calculate memory events from both char and prof memory
        memory_stats = state.core.get_memory_stats()
        char_events = memory_stats.get("char_memory", {}).get("total_events", 0)
        prof_events = memory_stats.get("prof_memory", {}).get("total_events", 0)
        total_memory_events = char_events + prof_events
        history_manager = state.core.history_manager

        return {
            "initialized": state.core.initialized,
            "em_llm_enabled": (
                state.core.char_em_llm_integrator is not None
                or state.core.prof_em_llm_integrator is not None
            ),
            "degraded": (
                state.core.char_em_llm_integrator is None
                and state.core.prof_em_llm_integrator is None
            ),
            # Count from DB using proper count method
            "total_messages": history_manager.get_message_count() if history_manager else 0,
            "memory_events": total_memory_events,
        }
    except Exception as e:
        logger.error("Failed to get status: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Failed to retrieve system status"})


@router.get("/api/config", dependencies=[Depends(get_api_key)])
async def get_config():
    """
    Get configuration with sensitive values redacted.
    Merges config.yml and secrets.yaml to show effective config.
    """
    try:
        service = get_config_service()
        config = service.load_config()
        # Use Pydantic model to ensure all default values are present
        validated_config = TeporaSettings(**config)
        # Dump back to dict, excluding secrets which are handled by redact_sensitive_values if present
        # but service.redact_sensitive_values expects a dict.
        # We use model_dump(mode="json") to get a clean dict with all defaults filled.
        full_config = validated_config.model_dump(mode="json")

        redacted_config = service.redact_sensitive_values(full_config)
        return redacted_config
    except Exception as e:
        logger.error("Failed to read config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/api/config", dependencies=[Depends(get_api_key)])
async def update_config(config_data: dict[str, Any]):
    """
    Update configuration with Pydantic validation.

    Splits configuration into:
    - config.yml (Public)
    - secrets.yaml (Sensitive, in USER_DATA_DIR)
    """
    try:
        service = get_config_service()
        success, errors = service.update_config(config_data, merge=False)

        if not success:
            logger.warning("Config validation failed: %s", errors)
            return JSONResponse(
                status_code=400, content={"error": "Invalid configuration", "details": errors}
            )

        # Reload in-memory settings so changes take effect without restart where possible.
        _reload_config_manager()

        logger.info("Configuration updated successfully")
        return {"status": "success"}
    except Exception as e:
        logger.error("Failed to update config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.patch("/api/config", dependencies=[Depends(get_api_key)])
async def patch_config(config_data: dict[str, Any]):
    """
    Partially update configuration.
    Merges configuration with existing values.
    """
    try:
        service = get_config_service()
        success, errors = service.update_config(config_data, merge=True)

        if not success:
            logger.warning("Config validation failed: %s", errors)
            return JSONResponse(
                status_code=400, content={"error": "Invalid configuration", "details": errors}
            )

        # Reload in-memory settings so changes take effect without restart where possible.
        _reload_config_manager()

        logger.info("Configuration patched successfully")
        return {"status": "success"}
    except Exception as e:
        logger.error("Failed to patch config: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/api/logs", dependencies=[Depends(get_api_key)])
async def get_logs():
    """List available log files."""
    try:
        log_dir = _get_log_dir()

        log_files = list(log_dir.glob("*.log"))
        # Sort by modification time, newest first
        log_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        return {"logs": [f.name for f in log_files]}
    except Exception as e:
        logger.error("Failed to list logs: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/api/logs/{filename}", dependencies=[Depends(get_api_key)])
async def get_log_content(filename: str):
    """Get content of a specific log file."""
    try:
        log_dir = _get_log_dir()

        # Prevent directory traversal using SecurityUtils
        try:
            file_path = SecurityUtils.safe_path_join(log_dir, filename)
        except ValueError:
            logger.warning("Attempted directory traversal: %s", filename)
            return JSONResponse(status_code=403, content={"error": "Invalid filename"})

        if not file_path.exists():
            return JSONResponse(status_code=404, content={"error": "Log file not found"})
        if not file_path.is_file():
            return JSONResponse(status_code=404, content={"error": "Log file not found"})

        # Limit to last 100KB to avoid huge payloads
        file_size = file_path.stat().st_size

        with open(file_path, encoding="utf-8", errors="replace") as f:
            if file_size > 100 * 1024:
                f.seek(file_size - 100 * 1024)
            content = f.read()

        return {"content": content}
    except Exception as e:
        logger.error("Failed to read log %s: %s", filename, e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})
