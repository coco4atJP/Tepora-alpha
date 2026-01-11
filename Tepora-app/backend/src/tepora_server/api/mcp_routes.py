"""
MCP API Routes - REST endpoints for MCP management.

Provides:
- GET /api/mcp/status - Connection status of all servers
- GET /api/mcp/config - Current MCP configuration
- POST /api/mcp/config - Update MCP configuration
- GET /api/mcp/store - List of available servers from registry
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.core.mcp.installer import McpInstaller
from src.tepora_server.api.dependencies import AppState, get_app_state
from src.tepora_server.api.security import get_api_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


# --- Request/Response Models ---


class McpServerStatusResponse(BaseModel):
    """Response model for server status."""

    name: str
    status: str  # connected, disconnected, error, connecting
    tools_count: int = 0
    error_message: str | None = None


class McpConfigUpdateRequest(BaseModel):
    """Request model for config update."""

    mcpServers: dict[str, Any]  # noqa: N815


class McpServerInstallRequest(BaseModel):
    """Request model for server installation."""

    server_id: str
    runtime: str | None = None
    env_values: dict[str, str] | None = None
    server_name: str | None = None  # Custom name for the server


class McpInstallConfirmRequest(BaseModel):
    """Request model for confirming installation after preview."""

    consent_id: str


class McpPolicyUpdateRequest(BaseModel):
    """Request model for policy update."""

    policy: str | None = None
    require_tool_confirmation: bool | None = None
    first_use_confirmation: bool | None = None


# --- Pending Consent Storage ---
# In-memory storage for pending consents (production should use persistent storage)
_pending_consents: dict[str, dict[str, Any]] = {}
CONSENT_EXPIRY_MINUTES = 5


# --- API Endpoints ---


@router.get("/status", dependencies=[Depends(get_api_key)])
async def get_mcp_status(state: AppState = Depends(get_app_state)) -> dict[str, Any]:
    """
    Get connection status of all configured MCP servers.

    Returns:
        Dictionary with server names as keys and status info as values
    """
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            return {"servers": {}, "error": "MCP Hub not initialized"}

        status_dict = state.mcp_hub.get_connection_status()

        # Convert to serializable format
        result = {}
        for name, status in status_dict.items():
            result[name] = {
                "status": status.status.value,
                "tools_count": status.tools_count,
                "error_message": status.error_message,
                "last_connected": status.last_connected,
            }

        return {"servers": result}

    except Exception as e:
        logger.error("Failed to get MCP status: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config", dependencies=[Depends(get_api_key)])
async def get_mcp_config(state: AppState = Depends(get_app_state)) -> dict[str, Any]:
    """
    Get current MCP configuration.

    Returns:
        Current mcp_tools_config.json content
    """
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            return {"mcpServers": {}}

        config = state.mcp_hub.get_config()

        # Convert to dict for JSON response
        return {
            "mcpServers": {
                name: {
                    "command": server.command,
                    "args": server.args,
                    "env": server.env or {},
                    "enabled": server.enabled,
                    "metadata": server.metadata.model_dump() if server.metadata else None,
                }
                for name, server in config.mcpServers.items()
            }
        }

    except Exception as e:
        logger.error("Failed to get MCP config: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config", dependencies=[Depends(get_api_key)])
async def update_mcp_config(
    request: McpConfigUpdateRequest, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """
    Update MCP configuration.

    This will trigger a hot-reload of the MCP Hub.
    """
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")

        success, error = await state.mcp_hub.update_config({"mcpServers": request.mcpServers})

        if not success:
            raise HTTPException(status_code=400, detail=error or "Failed to update config")

        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to update MCP config: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/store", dependencies=[Depends(get_api_key)])
async def get_mcp_store(
    state: AppState = Depends(get_app_state), search: str | None = None
) -> dict[str, Any]:
    """
    Get list of available MCP servers from registry.

    Args:
        search: Optional search query to filter servers

    Returns:
        List of available servers with metadata
    """
    try:
        if not hasattr(state, "mcp_registry") or state.mcp_registry is None:
            # Return empty list if registry not initialized
            return {"servers": []}

        if search:
            servers = await state.mcp_registry.search_servers(search)
        else:
            servers = await state.mcp_registry.fetch_servers()

        # Convert to serializable format
        return {
            "servers": [
                {
                    "id": s.id,
                    "name": s.name,
                    "description": s.description,
                    "vendor": s.vendor,
                    "packages": [
                        {
                            "name": p.name,
                            "runtimeHint": p.runtimeHint,
                            "registry": p.registry,
                        }
                        for p in s.packages
                    ],
                    "environmentVariables": [
                        {
                            "name": e.name,
                            "description": e.description,
                            "isRequired": e.isRequired,
                            "isSecret": e.isSecret,
                            "default": e.default,
                        }
                        for e in s.environmentVariables
                    ],
                    "icon": s.icon,
                    "category": s.category,
                    "sourceUrl": s.sourceUrl,
                }
                for s in servers
            ]
        }

    except Exception as e:
        logger.error("Failed to get MCP store: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/install/preview", dependencies=[Depends(get_api_key)])
async def preview_mcp_install(
    request: McpServerInstallRequest, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """
    Step 1 of 2-step install: Preview installation and get consent payload.

    Returns command details and warnings for user review before confirming.
    """
    try:
        if not hasattr(state, "mcp_registry") or state.mcp_registry is None:
            raise HTTPException(status_code=500, detail="MCP Registry not initialized")

        # Get server info from registry
        server = await state.mcp_registry.get_server_by_id(request.server_id)
        if not server:
            raise HTTPException(
                status_code=404, detail=f"Server '{request.server_id}' not found in registry"
            )

        # Generate consent payload
        consent_payload = McpInstaller.generate_consent_payload(
            server,
            runtime=request.runtime,
            env_values=request.env_values,
        )

        # Generate consent ID and store pending consent
        consent_id = secrets.token_urlsafe(16)
        _pending_consents[consent_id] = {
            "payload": consent_payload,
            "expires": datetime.now() + timedelta(minutes=CONSENT_EXPIRY_MINUTES),
            "request": request.model_dump(),
            "server": server,
        }

        # Cleanup expired consents
        _cleanup_expired_consents()

        return {
            "consent_id": consent_id,
            "expires_in_seconds": CONSENT_EXPIRY_MINUTES * 60,
            **consent_payload,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to preview MCP install: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/install/confirm", dependencies=[Depends(get_api_key)])
async def confirm_mcp_install(
    request: McpInstallConfirmRequest, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """
    Step 2 of 2-step install: Confirm and execute installation after user consent.
    """
    try:
        # Validate consent
        pending = _pending_consents.get(request.consent_id)
        if not pending:
            raise HTTPException(status_code=400, detail="Invalid or expired consent ID")

        if pending["expires"] < datetime.now():
            del _pending_consents[request.consent_id]
            raise HTTPException(status_code=400, detail="Consent has expired, please preview again")

        # Get stored data
        server = pending["server"]
        original_request = pending["request"]

        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")

        # Generate config
        config = McpInstaller.generate_config(
            server,
            runtime=original_request.get("runtime"),
            env_values=original_request.get("env_values"),
        )

        # Determine server name
        server_name = original_request.get("server_name") or original_request["server_id"]

        # Get current config and add new server
        current_config = state.mcp_hub.get_config()
        new_servers = {
            name: {
                "command": s.command,
                "args": s.args,
                "env": s.env or {},
                "enabled": s.enabled,
            }
            for name, s in current_config.mcpServers.items()
        }

        # Add new server (disabled by default for security - user must explicitly enable)
        new_servers[server_name] = {
            "command": config.command,
            "args": config.args,
            "env": config.env,
            "enabled": False,
            "metadata": {
                "name": server.name,
                "description": server.description,
            },
        }

        # Update config
        success, error = await state.mcp_hub.update_config({"mcpServers": new_servers})

        if not success:
            raise HTTPException(status_code=400, detail=error or "Failed to install server")

        # Remove used consent
        del _pending_consents[request.consent_id]

        logger.info(f"MCP server '{server_name}' installed with user consent")

        return {
            "status": "success",
            "server_name": server_name,
            "message": f"Server '{server_name}' installed successfully with consent",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to confirm MCP install: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


def _cleanup_expired_consents() -> None:
    """Remove expired consent entries to prevent memory leaks."""
    now = datetime.now()
    expired = [cid for cid, data in _pending_consents.items() if data["expires"] < now]
    for cid in expired:
        del _pending_consents[cid]
    if expired:
        logger.debug(f"Cleaned up {len(expired)} expired consent entries")


@router.post("/servers/{server_name}/enable", dependencies=[Depends(get_api_key)])
async def enable_server(
    server_name: str, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Enable a specific MCP server."""
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")

        success = await state.mcp_hub.enable_server(server_name)

        if not success:
            raise HTTPException(status_code=404, detail=f"Server '{server_name}' not found")

        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to enable server: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/servers/{server_name}/disable", dependencies=[Depends(get_api_key)])
async def disable_server(
    server_name: str, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Disable a specific MCP server."""
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")

        success = await state.mcp_hub.disable_server(server_name)

        if not success:
            raise HTTPException(status_code=404, detail=f"Server '{server_name}' not found")

        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to disable server: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/servers/{server_name}", dependencies=[Depends(get_api_key)])
async def delete_server(
    server_name: str, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Remove an MCP server from configuration."""
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")

        # Get current config
        config = state.mcp_hub.get_config()

        if server_name not in config.mcpServers:
            raise HTTPException(status_code=404, detail=f"Server '{server_name}' not found")

        # Remove server and update
        new_servers = {
            name: {
                "command": s.command,
                "args": s.args,
                "env": s.env or {},
                "enabled": s.enabled,
            }
            for name, s in config.mcpServers.items()
            if name != server_name
        }

        success, error = await state.mcp_hub.update_config({"mcpServers": new_servers})

        if not success:
            raise HTTPException(status_code=400, detail=error or "Failed to remove server")

        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to delete server: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/policy", dependencies=[Depends(get_api_key)])
async def get_mcp_policy(state: AppState = Depends(get_app_state)) -> dict[str, Any]:
    """Get current MCP connection policy."""
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            return {}

        policy_manager = state.mcp_hub.policy_manager
        if not policy_manager:
            return {"error": "Policy manager not configured"}

        config = policy_manager.get_policy()
        return config.model_dump()

    except Exception as e:
        logger.error("Failed to get MCP policy: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/policy", dependencies=[Depends(get_api_key)])
async def update_mcp_policy(
    request: McpPolicyUpdateRequest, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Update MCP connection policy."""
    try:
        if not hasattr(state, "mcp_hub") or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")

        policy_manager = state.mcp_hub.policy_manager
        if not policy_manager:
            raise HTTPException(status_code=500, detail="Policy manager not configured")

        # Update settings
        settings = request.model_dump(exclude_unset=True)
        policy_manager.update_settings(settings)

        return {"status": "success", "policy": policy_manager.get_policy().model_dump()}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to update MCP policy: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
