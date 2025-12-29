"""
Sessions API Routes - セッション履歴管理用APIエンドポイント

チャットセッションの一覧取得、作成、削除、名前変更を提供
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.tepora_server.api.security import get_api_key
from src.tepora_server.state import get_app_state, AppState
from fastapi import Request

logger = logging.getLogger("tepora.server.api.sessions")
router = APIRouter(prefix="/api/sessions", tags=["sessions"], dependencies=[Depends(get_api_key)])


class CreateSessionRequest(BaseModel):
    title: Optional[str] = None


class UpdateSessionRequest(BaseModel):
    title: str


@router.get("")
async def list_sessions(request: Request):
    """
    全セッション一覧を取得
    """
    try:
        app_state: AppState = get_app_state(request)
        sessions = app_state.core.history_manager.list_sessions()
        return {"sessions": sessions}
    except Exception as e:
        logger.error(f"Failed to list sessions: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("")
async def create_session(request: Request, body: CreateSessionRequest):
    """
    新しいセッションを作成
    """
    try:
        app_state: AppState = get_app_state(request)
        session_id = app_state.core.history_manager.create_session(title=body.title)
        session = app_state.core.history_manager.get_session(session_id)
        return {"session": session}
    except Exception as e:
        logger.error(f"Failed to create session: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/{session_id}")
async def get_session(request: Request, session_id: str):
    """
    特定のセッション情報を取得
    """
    try:
        app_state: AppState = get_app_state(request)
        session = app_state.core.history_manager.get_session(session_id)
        if session is None:
            return JSONResponse(status_code=404, content={"error": "Session not found"})
        
        # Get message history for the session
        messages = app_state.core.history_manager.get_history(session_id=session_id, limit=100)
        return {
            "session": session,
            "messages": [
                {
                    "type": msg.type,
                    "content": msg.content
                }
                for msg in messages
            ]
        }
    except Exception as e:
        logger.error(f"Failed to get session: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.patch("/{session_id}")
async def update_session(request: Request, session_id: str, body: UpdateSessionRequest):
    """
    セッションの名前を更新
    """
    try:
        app_state: AppState = get_app_state(request)
        success = app_state.core.history_manager.update_session_title(session_id, body.title)
        if not success:
            return JSONResponse(status_code=404, content={"error": "Session not found"})
        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to update session: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.delete("/{session_id}")
async def delete_session(request: Request, session_id: str):
    """
    セッションを削除
    """
    try:
        if session_id == "default":
            return JSONResponse(status_code=400, content={"error": "Cannot delete default session"})
        
        app_state: AppState = get_app_state(request)
        success = app_state.core.history_manager.delete_session(session_id)
        if not success:
            return JSONResponse(status_code=404, content={"error": "Session not found"})
        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to delete session: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})
