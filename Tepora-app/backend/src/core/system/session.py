"""
Session Module for Tepora V2

セッションのビジネスロジックを提供:
- セッションリソースの集約取得
- セッションライフサイクル管理
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from langchain_core.messages import BaseMessage

logger = logging.getLogger(__name__)


class SessionHistoryProtocol(Protocol):
    """セッション履歴インターフェース（同期版）

    Note:
        P1-2 修正: SessionHistory実装が同期であるため、プロトコルも同期に統一。
        現在のSQLite実装は同期であり、不必要なasyncラッパーを避けるため。
    """

    def get_messages(self, session_id: str, limit: int = 100) -> list[BaseMessage]:
        """セッションのメッセージを取得"""
        ...

    def add_message(self, session_id: str, message: BaseMessage) -> None:
        """セッションにメッセージを追加"""
        ...


class VectorStoreProtocol(Protocol):
    """ベクトルストアインターフェース"""

    async def search(self, query: str, session_id: str, k: int = 4) -> list[dict[str, Any]]:
        """セッションスコープでベクトル検索"""
        ...


@dataclass
class SessionResources:
    """セッションに関連するリソースをまとめたコンテナ"""

    session_id: str
    history: SessionHistoryProtocol | None = None
    vector_store: VectorStoreProtocol | None = None


class SessionManager:
    """
    セッションのビジネスロジックを管理

    責務:
    - セッションリソースの集約
    - 履歴・ベクトルストアへの委譲
    """

    def __init__(
        self,
        history_provider: SessionHistoryProtocol | None = None,
        vector_store_provider: VectorStoreProtocol | None = None,
    ):
        """
        Args:
            history_provider: 履歴プロバイダ（Phase 2で実装）
            vector_store_provider: ベクトルストアプロバイダ（Phase 3で実装）
        """
        self._history_provider = history_provider
        self._vector_store_provider = vector_store_provider
        self._active_sessions: dict[str, SessionResources] = {}

    def get_session_resources(self, session_id: str) -> SessionResources:
        """
        セッションに関連するリソースを取得

        Args:
            session_id: セッションID

        Returns:
            SessionResources: 履歴とベクトルストアを含むリソースコンテナ
        """
        if session_id not in self._active_sessions:
            self._active_sessions[session_id] = SessionResources(
                session_id=session_id,
                history=self._history_provider,
                vector_store=self._vector_store_provider,
            )
            logger.debug("Created session resources for: %s", session_id)

        return self._active_sessions[session_id]

    def release_session(self, session_id: str) -> bool:
        """
        セッションリソースを解放

        Args:
            session_id: セッションID

        Returns:
            解放された場合True
        """
        if session_id in self._active_sessions:
            del self._active_sessions[session_id]
            logger.debug("Released session resources for: %s", session_id)
            return True
        return False

    @property
    def active_session_count(self) -> int:
        """アクティブなセッション数"""
        return len(self._active_sessions)

    def list_active_sessions(self) -> list[str]:
        """アクティブなセッションIDのリスト"""
        return list(self._active_sessions.keys())
