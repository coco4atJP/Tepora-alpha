"""
WebSocket Endpoint

Handles WebSocket connections for real-time chat communication.
Processing logic is delegated to SessionHandler for better separation of concerns.
"""
import asyncio
import logging
import os
from typing import Optional, List, Dict, Any

from fastapi import (
    APIRouter,
    WebSocket,
    WebSocketDisconnect,
    HTTPException,
    status,
    Query,
    Depends
)
from pydantic import BaseModel

from src.tepora_server.api.dependencies import get_app_state_from_websocket
from src.tepora_server.api.session_handler import SessionHandler
from src.core.config.loader import get_session_token
import uuid

logger = logging.getLogger("tepora.server.ws")
router = APIRouter()

# Allowed WebSocket origins
WS_ALLOWED_ORIGINS = [
    "tauri://localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:8000",
    "http://localhost",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8000",
    "http://127.0.0.1",
]


class WSIncomingMessage(BaseModel):
    """Schema for incoming WebSocket messages."""
    type: Optional[str] = None
    message: Optional[str] = None
    mode: str = "direct"
    attachments: List[Dict[str, Any]] = []
    skipWebSearch: bool = False
    
    model_config = {
        "extra": "ignore"  # Ignore unknown fields
    }


def _validate_origin(origin: Optional[str]) -> bool:
    """Validate WebSocket connection origin."""
    if not origin:
        # No origin header - could be same-origin request
        return True
    
    for allowed in WS_ALLOWED_ORIGINS:
        # Exact match
        if origin == allowed:
            return True
        # Allow subpaths only (e.g., http://localhost:5173/path)
        # but not prefix matches (e.g., http://localhost.malicious.com)
        if origin.startswith(allowed + "/"):
            return True
    return False


def _validate_token(websocket: WebSocket) -> bool:
    """Validate session token from query params."""
    # In development mode, skip token validation
    env = os.getenv("TEPORA_ENV", "production")
    if env == "development":
        return True
    
    token = websocket.query_params.get("token")
    if not token:
        return True  # Allow connections without token for backwards compatibility
    
    expected_token = get_session_token()
    return token == expected_token


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Main WebSocket endpoint for chat communication.
    
    Handles:
    - Message processing (user input → AI response)
    - Stop commands (cancel current processing)
    - Stats requests (memory statistics)
    
    Security:
    - Origin validation (blocks external sites)
    - Session token authentication (optional, for enhanced security)
    """
    # Security: Validate origin
    origin = websocket.headers.get("origin")
    if not _validate_origin(origin):
        logger.warning(f"WebSocket connection rejected: invalid origin '{origin}'")
        await websocket.close(code=4003, reason="Forbidden: Invalid Origin")
        return
    
    # Security: Validate token (if provided)
    if not _validate_token(websocket):
        logger.warning(f"WebSocket connection rejected: invalid token")
        await websocket.close(code=4001, reason="Unauthorized: Invalid Token")
        return
    
    await websocket.accept()
    
    # Create session handler for this connection
    app_state = get_app_state_from_websocket(websocket)
    handler = SessionHandler(websocket, app_state)
    logger.info(f"WebSocket connection accepted from {handler.client_host}")
    
    try:
        while True:
            # Receive and validate message
            try:
                raw_data = await websocket.receive_json()
            except WebSocketDisconnect:
                raise  # Let outer handler handle clean disconnect
            except Exception as e:
                error_msg = str(e)
                # Check for disconnect-related errors in RuntimeError
                if "disconnect" in error_msg.lower() or "close" in error_msg.lower():
                    logger.info(f"Client disconnected (error detection): {handler.client_host}")
                    break
                
                logger.warning(f"Invalid JSON from {handler.client_host}: {e}")
                # Try to notify client, but if send fails, we should break
                if not await handler.send_json({"type": "error", "message": "Invalid JSON format"}):
                    break
                continue
            
            # Validate with Pydantic schema
            try:
                data = WSIncomingMessage.model_validate(raw_data)
            except Exception as validation_error:
                logger.warning(f"Message validation failed from {handler.client_host}: {validation_error}")
                await handler.send_json({
                    "type": "error", 
                    "message": f"Invalid message format: {validation_error}"
                })
                continue
            
            # Route message to appropriate handler
            msg_type = data.type

            # Handle stop command
            if msg_type == "stop":
                await handler.handle_stop()
                continue

            # Handle stats request
            if msg_type == "get_stats":
                await handler.handle_get_stats()
                continue

            # Handle message processing
            if data.message or data.attachments:
                # If a task is already running, ignore new message
                if handler.current_task and not handler.current_task.done():
                    logger.warning(f"Received new message from {handler.client_host} while processing. Ignoring.")
                    continue
                
                # Start processing in background task
                handler.current_task = asyncio.create_task(
                    handler.process_message(
                        data.message or "", 
                        data.mode, 
                        data.attachments, 
                        data.skipWebSearch
                    )
                )

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {handler.client_host}")
        await handler.handle_stop()
    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.error(f"Unexpected WebSocket error from {handler.client_host} (ID: {error_id}): {e}", exc_info=True)
        
        env = os.getenv("TEPORA_ENV", "production")
        
        if env == "development":
            error_message = f"Internal server error: {str(e)}"
        else:
            error_message = f"Internal server error (ID: {error_id})"
            
        await handler.send_json({"type": "error", "message": error_message})
        await handler.handle_stop()
