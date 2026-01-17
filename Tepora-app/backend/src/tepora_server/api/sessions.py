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
    history_manager = app_state.core.history_manager
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
    history_manager = app_state.core.history_manager
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
    history_manager = app_state.core.history_manager
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


@router.patch("/{session_id}")
async def update_session(
    session_id: str,
    body: UpdateSessionRequest,
    app_state: AppState = Depends(get_app_state),
):
    """Update a session's title."""
    history_manager = app_state.core.history_manager
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
    history_manager = app_state.core.history_manager
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
