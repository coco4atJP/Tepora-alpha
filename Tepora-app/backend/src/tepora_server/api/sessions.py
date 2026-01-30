"""
Sessions API Routes - Session History Management Endpoints

Provides chat session listing, creation, deletion, and title updates.
"""

import logging

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.tepora_server.api.security import get_api_key
from src.tepora_server.state import AppState, get_app_state

logger = logging.getLogger("tepora.server.api.sessions")
router = APIRouter(prefix="/api/sessions", tags=["sessions"], dependencies=[Depends(get_api_key)])


class CreateSessionRequest(BaseModel):
    title: str | None = None


class UpdateSessionRequest(BaseModel):
    title: str


@router.get("")
async def list_sessions(app_state: AppState = Depends(get_app_state)):
    """List all sessions."""
    history_manager = app_state.active_core.history_manager
    if history_manager is None:
        return JSONResponse(status_code=503, content={"error": "History manager not initialized"})
    try:
        sessions = history_manager.list_sessions()
        return {"sessions": sessions}
    except Exception as e:
        logger.error("Failed to list sessions: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("")
async def create_session(body: CreateSessionRequest, app_state: AppState = Depends(get_app_state)):
    """Create a new session."""
    history_manager = app_state.active_core.history_manager
    if history_manager is None:
        return JSONResponse(status_code=503, content={"error": "History manager not initialized"})
    try:
        session_id = history_manager.create_session(title=body.title)
        session = history_manager.get_session(session_id)
        return {"session": session}
    except Exception as e:
        logger.error("Failed to create session: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/{session_id}")
async def get_session(session_id: str, app_state: AppState = Depends(get_app_state)):
    """Get a specific session's information."""
    history_manager = app_state.active_core.history_manager
    if history_manager is None:
        return JSONResponse(status_code=503, content={"error": "History manager not initialized"})
    try:
        session = history_manager.get_session(session_id)
        if session is None:
            return JSONResponse(status_code=404, content={"error": "Session not found"})

        # Get message history for the session
        messages = history_manager.get_history(session_id=session_id, limit=100)
        return {
            "session": session,
            "messages": [{"type": msg.type, "content": msg.content} for msg in messages],
        }
    except Exception as e:
        logger.error("Failed to get session: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/{session_id}/messages")
async def get_session_messages(
    session_id: str,
    limit: int = 100,
    app_state: AppState = Depends(get_app_state),
):
    """Get message history for a session via REST API.

    This endpoint provides formatted messages suitable for the frontend,
    with proper role mapping and timestamp handling.
    """
    import uuid
    from datetime import datetime

    history_manager = app_state.active_core.history_manager
    if history_manager is None:
        return JSONResponse(status_code=503, content={"error": "History manager not initialized"})

    try:
        # Check if session exists
        session = history_manager.get_session(session_id)
        if session is None:
            return JSONResponse(status_code=404, content={"error": "Session not found"})

        # Get messages
        messages = history_manager.get_history(session_id=session_id, limit=limit)

        # Format messages for frontend
        formatted_messages = []
        for msg in messages:
            # Map message type to role
            role = "user"
            if msg.type == "ai":
                role = "assistant"
            elif msg.type == "system":
                role = "system"

            raw_id = getattr(msg, "id", None)
            if raw_id is None or (isinstance(raw_id, str) and raw_id.strip() == ""):
                message_id = str(uuid.uuid4())
            else:
                message_id = str(raw_id)

            formatted_messages.append(
                {
                    "id": message_id,
                    "role": role,
                    "content": msg.content,
                    "timestamp": msg.additional_kwargs.get("timestamp")
                    or datetime.now().isoformat(),
                    "mode": msg.additional_kwargs.get("mode", "chat"),
                    "isComplete": True,
                }
            )

        return {"messages": formatted_messages}
    except Exception as e:
        logger.error("Failed to get session messages: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.patch("/{session_id}")
async def update_session(
    session_id: str,
    body: UpdateSessionRequest,
    app_state: AppState = Depends(get_app_state),
):
    """Update a session's title."""
    history_manager = app_state.active_core.history_manager
    if history_manager is None:
        return JSONResponse(status_code=503, content={"error": "History manager not initialized"})
    try:
        success = history_manager.update_session_title(session_id, body.title)
        if not success:
            return JSONResponse(status_code=404, content={"error": "Session not found"})
        return {"success": True}
    except Exception as e:
        logger.error("Failed to update session: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.delete("/{session_id}")
async def delete_session(session_id: str, app_state: AppState = Depends(get_app_state)):
    """Delete a session."""
    history_manager = app_state.active_core.history_manager
    if history_manager is None:
        return JSONResponse(status_code=503, content={"error": "History manager not initialized"})
    try:
        success = history_manager.delete_session(session_id)
        if not success:
            return JSONResponse(status_code=404, content={"error": "Session not found"})
        return {"success": True}
    except Exception as e:
        logger.error("Failed to delete session: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})
