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
    "http://tauri.localhost",
]


class WSIncomingMessage(BaseModel):
    """Schema for incoming WebSocket messages."""
    type: Optional[str] = None
    message: Optional[str] = None
    mode: str = "direct"
    attachments: List[Dict[str, Any]] = []
    skipWebSearch: bool = False
    # Session management
    sessionId: Optional[str] = None
    # Tool confirmation fields
    requestId: Optional[str] = None
    approved: Optional[bool] = None
    
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
    current_session_id = "default"  # Track current session for this connection

    # --- Download Progress Integration ---
    from src.tepora_server.api.setup import _get_download_manager
    from src.core.download.types import ProgressEvent
    import json

    # 循環インポートを避けるためにここで取得
    dm = None
    send_progress = None
    try:
        dm = _get_download_manager()
        
        async def send_progress_callback(event: ProgressEvent):
            try:
                # Pydanticモデルを辞書に変換して送信
                await websocket.send_json({
                    "type": "download_progress",
                    "data": {
                        "status": event.status.value,
                        "progress": event.progress,
                        "message": event.message,
                        "job_id": event.job_id,
                        "current_bytes": event.current_bytes,
                        "total_bytes": event.total_bytes,
                        "speed_bps": event.speed_bps,
                        "eta_seconds": event.eta_seconds
                    }
                })
            except Exception as e:
                logger.warning(f"Failed to send progress: {e}")

        send_progress = send_progress_callback # Assign to the outer scope variable

        # コールバック登録 (DownloadManager側で非同期対応が必要な場合は考慮)
        # ModelManagerとBinaryManager (DownloadProgressManager) 両方に登録
        dm.download_progress.on_progress(send_progress)
        dm.model_manager.on_progress(send_progress)
        
    except Exception as e:
        logger.error(f"Failed to setup download progress: {e}")
        send_progress = None
        dm = None

    logger.info(f"WebSocket connection accepted from {handler.client_host}")
    
    try:
        while True:
            # Receive and validate message
            try:
                raw_data = await websocket.receive_json()
                # Message is now parsed as JSON, proceed to validation
            except WebSocketDisconnect:
                logger.info(f"WebSocket disconnected: {handler.client_host}")
                break
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
            
            # Handle session switching
            if msg_type == "set_session":
                if data.sessionId:
                    current_session_id = data.sessionId
                    logger.info(f"Session switched to {current_session_id} for {handler.client_host}")
                    await handler.send_json({"type": "session_changed", "sessionId": current_session_id})
                    # Send history for the new session
                    await handler.send_history(current_session_id)
                continue
            
            # Handle tool confirmation response
            if msg_type == "tool_confirmation_response":
                if data.requestId is not None and data.approved is not None:
                    handler.handle_tool_confirmation(data.requestId, data.approved)
                else:
                    logger.warning(f"Invalid tool_confirmation_response from {handler.client_host}")
                continue

            # Handle message processing
            if data.message or data.attachments:
                # If a task is already running, ignore new message
                if handler.current_task and not handler.current_task.done():
                    logger.warning(f"Received new message from {handler.client_host} while processing. Ignoring.")
                    continue
                
                # Use session_id from message or current connection session
                session_id = data.sessionId or current_session_id
                
                # Start processing in background task
                handler.current_task = asyncio.create_task(
                    handler.process_message(
                        data.message or "", 
                        data.mode, 
                        data.attachments, 
                        data.skipWebSearch,
                        session_id
                    )
                )

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {handler.client_host}")
        await handler.handle_stop()
    except Exception as e:
        logger.error(f"WebSocket loop error: {e}")
    finally:
        # Cleanup callbacks
        if dm and send_progress:
            try:
                dm.download_progress.remove_callback(send_progress)
            except Exception:
                pass 
            
            # Remove from ModelManager
            if dm and hasattr(dm.model_manager, "remove_progress_callback"):
                 dm.model_manager.remove_progress_callback(send_progress)
            
        await handler.on_disconnect()
