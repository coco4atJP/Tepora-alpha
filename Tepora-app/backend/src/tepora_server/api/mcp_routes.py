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
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.tepora_server.api.security import get_api_key
from src.tepora_server.api.dependencies import get_app_state, AppState

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


# --- Request/Response Models ---

class McpServerStatusResponse(BaseModel):
    """Response model for server status."""
    name: str
    status: str  # connected, disconnected, error, connecting
    tools_count: int = 0
    error_message: Optional[str] = None


class McpConfigUpdateRequest(BaseModel):
    """Request model for config update."""
    mcpServers: Dict[str, Any]


class McpServerInstallRequest(BaseModel):
    """Request model for server installation."""
    server_id: str
    runtime: Optional[str] = None
    env_values: Optional[Dict[str, str]] = None
    server_name: Optional[str] = None  # Custom name for the server


# --- API Endpoints ---

@router.get("/status")
async def get_mcp_status(
    state: AppState = Depends(get_app_state)
) -> Dict[str, Any]:
    """
    Get connection status of all configured MCP servers.
    
    Returns:
        Dictionary with server names as keys and status info as values
    """
    try:
        if not hasattr(state, 'mcp_hub') or state.mcp_hub is None:
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
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@router.get("/config", dependencies=[Depends(get_api_key)])
async def get_mcp_config(
    state: AppState = Depends(get_app_state)
) -> Dict[str, Any]:
    """
    Get current MCP configuration.
    
    Returns:
        Current mcp_tools_config.json content
    """
    try:
        if not hasattr(state, 'mcp_hub') or state.mcp_hub is None:
            return {"mcpServers": {}}
            
        config = state.mcp_hub.get_config()
        
        # Convert to dict for JSON response
        return {
            "mcpServers": {
                name: {
                    "command": server.command,
                    "args": server.args,
                    "env": server.env,
                    "enabled": server.enabled,
                    "metadata": server.metadata.model_dump() if server.metadata else None,
                }
                for name, server in config.mcpServers.items()
            }
        }
        
    except Exception as e:
        logger.error("Failed to get MCP config: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@router.post("/config", dependencies=[Depends(get_api_key)])
async def update_mcp_config(
    request: McpConfigUpdateRequest,
    state: AppState = Depends(get_app_state)
) -> Dict[str, Any]:
    """
    Update MCP configuration.
    
    This will trigger a hot-reload of the MCP Hub.
    """
    try:
        if not hasattr(state, 'mcp_hub') or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")
            
        success, error = await state.mcp_hub.update_config(
            {"mcpServers": request.mcpServers}
        )
        
        if not success:
            return JSONResponse(
                status_code=400,
                content={"error": error or "Failed to update config"}
            )
            
        return {"status": "success"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to update MCP config: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@router.get("/store")
async def get_mcp_store(
    state: AppState = Depends(get_app_state),
    search: Optional[str] = None
) -> Dict[str, Any]:
    """
    Get list of available MCP servers from registry.
    
    Args:
        search: Optional search query to filter servers
        
    Returns:
        List of available servers with metadata
    """
    try:
        if not hasattr(state, 'mcp_registry') or state.mcp_registry is None:
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
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@router.post("/install", dependencies=[Depends(get_api_key)])
async def install_mcp_server(
    request: McpServerInstallRequest,
    state: AppState = Depends(get_app_state)
) -> Dict[str, Any]:
    """
    Install an MCP server from the registry.
    
    This will:
    1. Fetch server info from registry
    2. Generate appropriate config
    3. Add to mcp_tools_config.json
    4. Trigger hot-reload to connect
    """
    try:
        if not hasattr(state, 'mcp_registry') or state.mcp_registry is None:
            raise HTTPException(status_code=500, detail="MCP Registry not initialized")
            
        if not hasattr(state, 'mcp_hub') or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")
            
        # Get server info from registry
        server = await state.mcp_registry.get_server_by_id(request.server_id)
        if not server:
            raise HTTPException(status_code=404, detail=f"Server '{request.server_id}' not found in registry")
            
        # Generate config using installer
        from src.core.mcp.installer import McpInstaller
        
        config = McpInstaller.generate_config(
            server,
            runtime=request.runtime,
            env_values=request.env_values,
        )
        
        # Determine server name
        server_name = request.server_name or request.server_id
        
        # Get current config and add new server
        current_config = state.mcp_hub.get_config()
        new_servers = {
            name: {
                "command": s.command,
                "args": s.args,
                "env": s.env,
                "enabled": s.enabled,
            }
            for name, s in current_config.mcpServers.items()
        }
        
        # Add new server
        new_servers[server_name] = {
            "command": config.command,
            "args": config.args,
            "env": config.env,
            "enabled": True,
            "metadata": {
                "name": server.name,
                "description": server.description,
            }
        }
        
        # Update config
        success, error = await state.mcp_hub.update_config({"mcpServers": new_servers})
        
        if not success:
            return JSONResponse(
                status_code=400,
                content={"error": error or "Failed to install server"}
            )
            
        return {
            "status": "success",
            "server_name": server_name,
            "message": f"Server '{server_name}' installed successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to install MCP server: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@router.post("/servers/{server_name}/enable", dependencies=[Depends(get_api_key)])
async def enable_server(
    server_name: str,
    state: AppState = Depends(get_app_state)
) -> Dict[str, Any]:
    """Enable a specific MCP server."""
    try:
        if not hasattr(state, 'mcp_hub') or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")
            
        success = await state.mcp_hub.enable_server(server_name)
        
        if not success:
            return JSONResponse(
                status_code=404,
                content={"error": f"Server '{server_name}' not found"}
            )
            
        return {"status": "success"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to enable server: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@router.post("/servers/{server_name}/disable", dependencies=[Depends(get_api_key)])
async def disable_server(
    server_name: str,
    state: AppState = Depends(get_app_state)
) -> Dict[str, Any]:
    """Disable a specific MCP server."""
    try:
        if not hasattr(state, 'mcp_hub') or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")
            
        success = await state.mcp_hub.disable_server(server_name)
        
        if not success:
            return JSONResponse(
                status_code=404,
                content={"error": f"Server '{server_name}' not found"}
            )
            
        return {"status": "success"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to disable server: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


@router.delete("/servers/{server_name}", dependencies=[Depends(get_api_key)])
async def delete_server(
    server_name: str,
    state: AppState = Depends(get_app_state)
) -> Dict[str, Any]:
    """Remove an MCP server from configuration."""
    try:
        if not hasattr(state, 'mcp_hub') or state.mcp_hub is None:
            raise HTTPException(status_code=500, detail="MCP Hub not initialized")
            
        # Get current config
        config = state.mcp_hub.get_config()
        
        if server_name not in config.mcpServers:
            return JSONResponse(
                status_code=404,
                content={"error": f"Server '{server_name}' not found"}
            )
            
        # Remove server and update
        new_servers = {
            name: {
                "command": s.command,
                "args": s.args,
                "env": s.env,
                "enabled": s.enabled,
            }
            for name, s in config.mcpServers.items()
            if name != server_name
        }
        
        success, error = await state.mcp_hub.update_config({"mcpServers": new_servers})
        
        if not success:
            return JSONResponse(
                status_code=400,
                content={"error": error or "Failed to remove server"}
            )
            
        return {"status": "success"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to delete server: %s", e)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )
