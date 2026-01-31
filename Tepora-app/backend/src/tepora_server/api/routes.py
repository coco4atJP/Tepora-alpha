import logging
import os
import signal
from datetime import UTC
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from src.core import config as core_config
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
    core = state.active_core
    return {
        "status": "ok",
        "initialized": core.initialized,
        "core_version": "v2",
    }


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
        core = state.active_core
        # Calculate memory events from both char and prof memory
        memory_stats = core.get_memory_stats()
        char_events = memory_stats.get("char_memory", {}).get("total_events", 0)
        prof_events = memory_stats.get("prof_memory", {}).get("total_events", 0)
        total_memory_events = char_events + prof_events
        history_manager = core.history_manager

        return {
            "initialized": core.initialized,
            "core_version": "v2",
            "em_llm_enabled": (
                core.char_em_llm_integrator is not None or core.prof_em_llm_integrator is not None
            ),
            "degraded": (
                core.char_em_llm_integrator is None and core.prof_em_llm_integrator is None
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

        # Resolve mcp_config_path to absolute path for checking
        if "app" in full_config and "mcp_config_path" in full_config["app"]:
            try:
                mcp_path = Path(full_config["app"]["mcp_config_path"])
                if not mcp_path.is_absolute():
                    mcp_path = core_config.USER_DATA_DIR / mcp_path
                full_config["app"]["mcp_config_path"] = str(mcp_path.resolve())
            except Exception as e:
                logger.warning("Failed to resolve absolute path for mcp_config_path: %s", e)

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


# =============================================================================
# Custom Agent API Endpoints
# =============================================================================


@router.get("/api/custom-agents", dependencies=[Depends(get_api_key)])
async def list_custom_agents(enabled_only: bool = False):
    """
    List all custom agents.

    Args:
        enabled_only: If True, only return enabled agents
    """
    try:
        service = get_config_service()
        agents = service.list_custom_agents(enabled_only=enabled_only)

        # Convert to dicts for JSON serialization (service already returns dicts)
        return {"agents": agents}
    except Exception as e:
        logger.error("Failed to list custom agents: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/api/custom-agents/{agent_id}", dependencies=[Depends(get_api_key)])
async def get_custom_agent(agent_id: str):
    """Get a single custom agent by ID."""
    try:
        service = get_config_service()
        agent = service.get_custom_agent(agent_id)
        if not agent:
            return JSONResponse(status_code=404, content={"error": "Agent not found"})

        return agent
    except Exception as e:
        logger.error("Failed to get custom agent %s: %s", agent_id, e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/api/custom-agents", dependencies=[Depends(get_api_key)])
async def create_custom_agent(agent_data: dict[str, Any]):
    """
    Create a new custom agent.

    Required fields: id, name, system_prompt
    """
    try:
        service = get_config_service()
        success, result = service.create_custom_agent(agent_data)

        if not success:
            # Result is error message string
            # Check for specific error messages to determine status code
            if "Agent ID already exists" in str(result):
                return JSONResponse(status_code=409, content={"error": result})
            elif "required" in str(result):
                return JSONResponse(status_code=400, content={"error": result})
            else:
                return JSONResponse(
                    status_code=400, content={"error": "Failed to create agent", "details": result}
                )

        _reload_config_manager()
        logger.info("Created custom agent: %s", agent_data.get("id"))

        return {"status": "success", "agent": result}
    except Exception as e:
        logger.error("Failed to create custom agent: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.put("/api/custom-agents/{agent_id}", dependencies=[Depends(get_api_key)])
async def update_custom_agent(agent_id: str, agent_data: dict[str, Any]):
    """Update an existing custom agent."""
    try:
        service = get_config_service()
        success, result = service.update_custom_agent(agent_id, agent_data)

        if not success:
            if "Agent not found" in str(result):
                return JSONResponse(status_code=404, content={"error": "Agent not found"})
            return JSONResponse(
                status_code=400, content={"error": "Failed to update agent", "details": result}
            )

        _reload_config_manager()
        logger.info("Updated custom agent: %s", agent_id)

        return {"status": "success", "agent": result}
    except Exception as e:
        logger.error("Failed to update custom agent %s: %s", agent_id, e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.delete("/api/custom-agents/{agent_id}", dependencies=[Depends(get_api_key)])
async def delete_custom_agent(agent_id: str):
    """Delete a custom agent."""
    try:
        service = get_config_service()
        success, result = service.delete_custom_agent(agent_id)

        if not success:
            if "Agent not found" in str(result):
                return JSONResponse(status_code=404, content={"error": "Agent not found"})
            return JSONResponse(
                status_code=400, content={"error": "Failed to delete agent", "details": result}
            )

        _reload_config_manager()
        logger.info("Deleted custom agent: %s", agent_id)

        return {"status": "success"}
    except Exception as e:
        logger.error("Failed to delete custom agent %s: %s", agent_id, e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/api/tools", dependencies=[Depends(get_api_key)])
async def list_available_tools(state: AppState = Depends(get_app_state)):
    """
    List all available tools.

    Returns tool names and descriptions for UI selection.
    """
    try:
        tool_manager = state.active_core.tool_manager
        if not tool_manager:
            return {"tools": []}

        tools = []
        for tool in tool_manager.all_tools:
            tools.append(
                {
                    "name": tool.name,
                    "description": getattr(tool, "description", ""),
                }
            )

        return {"tools": tools}
    except Exception as e:
        logger.error("Failed to list tools: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})
