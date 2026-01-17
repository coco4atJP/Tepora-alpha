"""
MCP API Routes - REST endpoints for MCP management.

Provides:
- GET /api/mcp/status - Connection status of all servers
- GET /api/mcp/config - Current MCP configuration
- POST /api/mcp/config - Update MCP configuration
- GET /api/mcp/store - List of available servers from registry
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.core.mcp.installer import McpInstaller
from src.tepora_server.api.dependencies import AppState, get_app_state
from src.tepora_server.api.security import get_api_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mcp", tags=["mcp"], dependencies=[Depends(get_api_key)])

_SERVER_KEY_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9_-]")


# --- Request/Response Models ---


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


def _normalize_server_key(raw: str) -> str:
    """
    Normalize a registry/server identifier into a safe MCP server key.

    This key is used as:
    - the config key in `mcp_tools_config.json`
    - the prefix for tool names (e.g. `{server_key}_{tool_name}`)
    """
    if not raw:
        return "mcp_server"

    # Prefer the segment after the namespace (reverse-DNS name like `io.github.user/weather`)
    base = raw.split("/", 1)[-1]
    base = _SERVER_KEY_UNSAFE_CHARS.sub("_", base).strip("_")
    return base or "mcp_server"


def _make_unique_server_key(base: str, existing: set[str]) -> str:
    if base not in existing:
        return base
    i = 2
    while f"{base}_{i}" in existing:
        i += 1
    return f"{base}_{i}"


def _dump_server_config(server: Any) -> dict[str, Any]:
    """Serialize McpServerConfig into the config file shape without dropping metadata."""
    data: dict[str, Any] = {
        "command": server.command,
        "args": server.args,
        "env": server.env or {},
        "enabled": server.enabled,
        "transport": getattr(server.transport, "value", server.transport),
    }
    if getattr(server, "url", None):
        data["url"] = server.url
    if getattr(server, "metadata", None):
        data["metadata"] = server.metadata.model_dump(exclude_none=True)
    return data


async def _reload_core_tools(state: AppState) -> None:
    """
    Reload the core ToolManager so MCP enable/disable/install is reflected immediately.

    This is best-effort; failures should not break MCP config updates.
    """
    try:
        core = getattr(state, "core", None)
        if not core or not getattr(core, "tool_manager", None):
            return
        await asyncio.to_thread(core.tool_manager.initialize)
    except Exception as e:
        logger.warning("Failed to reload ToolManager after MCP change: %s", e, exc_info=True)


def _get_mcp_hub(state: AppState, *, required: bool = True):
    hub = getattr(state, "mcp_hub", None)
    if hub is None:
        if required:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")
        return None
    return hub


def _get_mcp_registry(state: AppState, *, required: bool = True):
    registry = getattr(state, "mcp_registry", None)
    if registry is None:
        if required:
            raise HTTPException(status_code=500, detail="MCP Registry not initialized")
        return None
    return registry


@router.get("/status")
async def get_mcp_status(state: AppState = Depends(get_app_state)) -> dict[str, Any]:
    """
    Get connection status of all configured MCP servers.

    Returns:
        Dictionary with server names as keys and status info as values
    """
    try:
        hub = _get_mcp_hub(state, required=False)
        if hub is None:
            return {"servers": {}, "error": "MCP Hub not initialized"}

        status_dict = hub.get_connection_status()

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
        logger.error("Failed to get MCP status: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config")
async def get_mcp_config(state: AppState = Depends(get_app_state)) -> dict[str, Any]:
    """
    Get current MCP configuration.

    Returns:
        Current mcp_tools_config.json content
    """
    try:
        hub = _get_mcp_hub(state, required=False)
        if hub is None:
            return {"mcpServers": {}}

        config = hub.get_config()

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
        logger.error("Failed to get MCP config: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config")
async def update_mcp_config(
    request: McpConfigUpdateRequest, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """
    Update MCP configuration.

    This will trigger a hot-reload of the MCP Hub.
    """
    try:
        hub = _get_mcp_hub(state)
        success, error = await hub.update_config({"mcpServers": request.mcpServers})

        if not success:
            raise HTTPException(status_code=400, detail=error or "Failed to update config")

        await _reload_core_tools(state)
        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to update MCP config: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/store")
async def get_mcp_store(
    state: AppState = Depends(get_app_state),
    search: str | None = None,
    page: int = 1,
    page_size: int = 50,
    runtime: str | None = None,
    refresh: bool = False,
) -> dict[str, Any]:
    """
    Get list of available MCP servers from registry.

    Args:
        search: Optional search query to filter servers
        page: 1-based page number
        page_size: Items per page (max 200)
        runtime: Optional runtime filter (e.g. npx, uvx, docker)
        refresh: Force-refresh registry cache

    Returns:
        List of available servers with metadata
    """
    try:
        registry = _get_mcp_registry(state, required=False)
        if registry is None:
            # Return empty list if registry not initialized
            return {
                "servers": [],
                "total": 0,
                "page": page,
                "page_size": page_size,
                "has_more": False,
            }

        # Clamp pagination inputs
        if page < 1:
            page = 1
        page_size = max(1, min(page_size, 200))

        servers = await registry.fetch_servers(force_refresh=refresh, search=search)

        if runtime:
            runtime_lower = runtime.lower()
            servers = [
                s
                for s in servers
                if any((p.runtimeHint or "").lower() == runtime_lower for p in s.packages)
            ]

        # Stable ordering for consistent pagination/UI rendering
        servers.sort(key=lambda s: (s.name or "").lower())

        total = len(servers)
        start = (page - 1) * page_size
        end = start + page_size
        paged = servers[start:end] if start < total else []

        # Convert to serializable format
        return {
            "servers": [
                {
                    "id": s.id,
                    "name": s.name,
                    "title": s.title,
                    "description": s.description,
                    "version": s.version,
                    "vendor": s.vendor,
                    "packages": [
                        {
                            "name": p.package_name,
                            "runtimeHint": p.runtimeHint,
                            "registry": p.package_registry,
                            "version": p.version,
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
                    "homepage": s.homepage,
                    "websiteUrl": s.websiteUrl,
                }
                for s in paged
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": end < total,
        }

    except Exception as e:
        logger.error("Failed to get MCP store: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/install/preview")
async def preview_mcp_install(
    request: McpServerInstallRequest, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """
    Step 1 of 2-step install: Preview installation and get consent payload.

    Returns command details and warnings for user review before confirming.
    """
    try:
        registry = _get_mcp_registry(state)

        # Get server info from registry
        server = await registry.get_server_by_id(request.server_id)
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
        logger.error("Failed to preview MCP install: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/install/confirm")
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

        hub = _get_mcp_hub(state)

        # Generate config
        config = McpInstaller.generate_config(
            server,
            runtime=original_request.get("runtime"),
            env_values=original_request.get("env_values"),
        )

        # Determine server name
        current_config = hub.get_config()
        existing_names = set(current_config.mcpServers.keys())

        requested_name = original_request.get("server_name")
        base_name = _normalize_server_key(requested_name or original_request["server_id"])
        server_name = _make_unique_server_key(base_name, existing_names)

        new_servers = {
            name: _dump_server_config(s) for name, s in current_config.mcpServers.items()
        }

        # Add new server (disabled by default for security - user must explicitly enable)
        new_servers[server_name] = {
            "command": config.command,
            "args": config.args,
            "env": config.env,
            "enabled": False,
            "transport": config.transport.value,
            "metadata": {
                "name": server.title or server.name,
                "description": server.description,
                "icon": server.icon,
            },
        }

        # Update config
        success, error = await hub.update_config({"mcpServers": new_servers})

        if not success:
            raise HTTPException(status_code=400, detail=error or "Failed to install server")

        await _reload_core_tools(state)

        # Remove used consent
        del _pending_consents[request.consent_id]

        logger.info("MCP server '%s' installed with user consent", server_name)

        return {
            "status": "success",
            "server_name": server_name,
            "message": f"Server '{server_name}' installed successfully with consent",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to confirm MCP install: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _cleanup_expired_consents() -> None:
    """Remove expired consent entries to prevent memory leaks."""
    now = datetime.now()
    expired = [cid for cid, data in _pending_consents.items() if data["expires"] < now]
    for cid in expired:
        del _pending_consents[cid]
    if expired:
        logger.debug("Cleaned up %d expired consent entries", len(expired))


@router.post("/servers/{server_name}/enable")
async def enable_server(
    server_name: str, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Enable a specific MCP server."""
    try:
        hub = _get_mcp_hub(state)
        success = await hub.enable_server(server_name)

        if not success:
            raise HTTPException(status_code=404, detail=f"Server '{server_name}' not found")

        await _reload_core_tools(state)
        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to enable server: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/servers/{server_name}/disable")
async def disable_server(
    server_name: str, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Disable a specific MCP server."""
    try:
        hub = _get_mcp_hub(state)
        success = await hub.disable_server(server_name)

        if not success:
            raise HTTPException(status_code=404, detail=f"Server '{server_name}' not found")

        await _reload_core_tools(state)
        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to disable server: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/servers/{server_name}")
async def delete_server(
    server_name: str, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Remove an MCP server from configuration."""
    try:
        hub = _get_mcp_hub(state)
        config = hub.get_config()

        if server_name not in config.mcpServers:
            raise HTTPException(status_code=404, detail=f"Server '{server_name}' not found")

        # Remove server and update (preserve per-server metadata/transport/etc)
        new_servers = {
            name: _dump_server_config(s)
            for name, s in config.mcpServers.items()
            if name != server_name
        }

        success, error = await hub.update_config({"mcpServers": new_servers})

        if not success:
            raise HTTPException(status_code=400, detail=error or "Failed to remove server")

        await _reload_core_tools(state)
        return {"status": "success"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to delete server: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/policy")
async def get_mcp_policy(state: AppState = Depends(get_app_state)) -> dict[str, Any]:
    """Get current MCP connection policy."""
    try:
        hub = _get_mcp_hub(state, required=False)
        if hub is None:
            return {}

        policy_manager = hub.policy_manager
        if not policy_manager:
            return {"error": "Policy manager not configured"}

        config = policy_manager.get_policy()
        return dict(config.model_dump())

    except Exception as e:
        logger.error("Failed to get MCP policy: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/policy")
async def update_mcp_policy(
    request: McpPolicyUpdateRequest, state: AppState = Depends(get_app_state)
) -> dict[str, Any]:
    """Update MCP connection policy."""
    try:
        hub = _get_mcp_hub(state)
        policy_manager = hub.policy_manager
        if not policy_manager:
            raise HTTPException(status_code=500, detail="Policy manager not configured")

        # Update settings
        settings = request.model_dump(exclude_unset=True)
        policy_manager.update_settings(settings)

        return {"status": "success", "policy": policy_manager.get_policy().model_dump()}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to update MCP policy: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
