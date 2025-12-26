import logging
from pathlib import Path
from typing import Any, Dict
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from src.core.config.loader import LOG_DIR
from src.tepora_server.api.security import get_api_key
from src.core.config.service import get_config_service
from src.core.common.security import SecurityUtils
from src.tepora_server.api.dependencies import get_app_state, AppState

logger = logging.getLogger("tepora.server.api")
router = APIRouter()


def _get_log_dir() -> Path:
    """Ensure log directory exists and return path."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return LOG_DIR




# --- Routes ---

@router.get("/health")
async def health_check(state: AppState = Depends(get_app_state)):
    return {"status": "ok", "initialized": state.core.initialized}


@router.get("/api/personas")
async def get_persona_presets():
    """
    PERSONA_PROMPTSのプリセット一覧を取得
    """
    try:
        from src.core.config.prompts import PERSONA_PROMPTS
        return {
            "personas": [
                {
                    "key": key,
                    "preview": prompt[:150] + "..." if len(prompt) > 150 else prompt
                }
                for key, prompt in PERSONA_PROMPTS.items()
            ]
        }
    except Exception as e:
        logger.error(f"Failed to get persona presets: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})

@router.get("/api/status")
async def get_status(state: AppState = Depends(get_app_state)):
    """Get system status information."""
    try:
        # Calculate memory events from both char and prof memory
        memory_stats = state.core.get_memory_stats()
        char_events = memory_stats.get("char_memory", {}).get("total_events", 0)
        prof_events = memory_stats.get("prof_memory", {}).get("total_events", 0)
        total_memory_events = char_events + prof_events
        
        return {
            "initialized": state.core.initialized,
            "em_llm_enabled": (
                state.core.char_em_llm_integrator is not None or 
                state.core.prof_em_llm_integrator is not None
            ),
            # Count from DB using proper count method
            "total_messages": state.core.history_manager.get_message_count(),
            "memory_events": total_memory_events
        }
    except Exception as e:
        logger.error(f"Failed to get status: {e}", exc_info=True)
        return JSONResponse(
            status_code=500, 
            content={"error": "Failed to retrieve system status"}
        )

@router.get("/api/config", dependencies=[Depends(get_api_key)])
async def get_config():
    """
    Get configuration with sensitive values redacted.
    Merges config.yml and secrets.yaml to show effective config.
    """
    try:
        service = get_config_service()
        config = service.load_config()
        redacted_config = service.redact_sensitive_values(config)
        return redacted_config
    except Exception as e:
        logger.error(f"Failed to read config: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})

@router.post("/api/config", dependencies=[Depends(get_api_key)])
async def update_config(config_data: Dict[str, Any]):
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
            logger.warning(f"Config validation failed: {errors}")
            return JSONResponse(
                status_code=400, 
                content={
                    "error": "Invalid configuration",
                    "details": errors
                }
            )
        
        logger.info("Configuration updated successfully")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Failed to update config: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})

@router.patch("/api/config", dependencies=[Depends(get_api_key)])
async def patch_config(config_data: Dict[str, Any]):
    """
    Partially update configuration.
    Merges configuration with existing values.
    """
    try:
        service = get_config_service()
        success, errors = service.update_config(config_data, merge=True)
        
        if not success:
            logger.warning(f"Config validation failed: {errors}")
            return JSONResponse(
                status_code=400, 
                content={
                    "error": "Invalid configuration",
                    "details": errors
                }
            )
        
        logger.info("Configuration patched successfully")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Failed to patch config: {e}", exc_info=True)
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
        logger.error(f"Failed to list logs: {e}", exc_info=True)
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
             logger.warning(f"Attempted directory traversal: {filename}")
             return JSONResponse(status_code=403, content={"error": "Invalid filename"})

        if not file_path.exists():
            return JSONResponse(status_code=404, content={"error": "Log file not found"})
            
        # Limit to last 100KB to avoid huge payloads
        file_size = file_path.stat().st_size
        
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            if file_size > 100 * 1024:
                f.seek(file_size - 100 * 1024)
            content = f.read()
            
        return {"content": content}
    except Exception as e:
        logger.error(f"Failed to read log {filename}: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})
