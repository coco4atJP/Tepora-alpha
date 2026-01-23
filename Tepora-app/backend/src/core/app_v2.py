"""
TeporaApp - V2 Application Facade

アプリケーションのメインエントリポイント。
全てのV2コンポーネントを統合し、統一されたAPIを提供します。

使用例:
    from core_v2 import TeporaApp
    from core.config import settings

    app = TeporaApp(config=settings.app)
    await app.initialize()

    async for chunk in app.process_message("session-1", "Hello!"):
        print(chunk, end="")

    await app.shutdown()
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .context import ContextWindowManager
from .graph import TeporaGraph
from .llm import LLMService
from .rag import RAGContextBuilder, RAGEngine
from .system import SessionManager, get_logger, setup_logging
from .tools import ToolManager, ToolProvider

if TYPE_CHECKING:
    from pathlib import Path

    from src.core.download import DownloadManager
    from src.core.models import ModelManager


logger = get_logger(__name__)


@dataclass
class TeporaAppConfig:
    """TeporaApp設定"""

    log_dir: Path | None = None
    log_level: int = logging.INFO
    pii_redaction: bool = False
    tool_timeout: int = 30
    tool_providers: list[ToolProvider] = field(default_factory=list)


class TeporaApp:
    """
    V2アプリケーションのメインエントリポイント

    責務:
    - 全コンポーネントの初期化と終了処理
    - メッセージ処理のエントリポイント
    - セッション管理

    Phase 1: System (Logging, Session), Tools
    Phase 2: LLM Service (Stateless), Context (History)
    Phase 3: RAG, Graph, Agent (Skeleton)
    """

    def __init__(self, config: TeporaAppConfig | None = None):
        """
        Args:
            config: アプリケーション設定
        """
        self.config = config or TeporaAppConfig()
        self._initialized = False

        # Phase 1 コンポーネント
        self._session_manager: SessionManager | None = None
        self._tool_manager: ToolManager | None = None

        # Phase 2 コンポーネント
        self._llm_service: LLMService | None = None
        self._download_manager: DownloadManager | None = None
        self._model_manager: ModelManager | None = None

        # Phase 3 コンポーネント
        self._context_manager: ContextWindowManager | None = None
        self._rag_engine: RAGEngine | None = None
        self._context_builder: RAGContextBuilder | None = None
        self._graph: TeporaGraph | None = None

        # Phase 4 外部依存性
        self._mcp_hub = None

    @property
    def is_initialized(self) -> bool:
        """初期化済みかどうか"""
        return self._initialized

    @property
    def initialized(self) -> bool:
        """V1互換: 初期化済みフラグ"""
        return self._initialized

    @property
    def history_manager(self):
        """
        V1互換: 履歴マネージャー

        V1ではChatHistoryManagerを返していたが、V2ではSessionManagerの
        履歴プロバイダを返す。履歴プロバイダが未設定の場合はNone。
        """
        if self._session_manager:
            # V2: SessionManagerの履歴プロバイダを返す
            return self._session_manager._history_provider
        return None

    @property
    def session_manager(self) -> SessionManager:
        """セッションマネージャーを取得"""
        if self._session_manager is None:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")
        return self._session_manager

    @property
    def tool_manager(self) -> ToolManager:
        """ツールマネージャーを取得"""
        if self._tool_manager is None:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")
        return self._tool_manager

    @property
    def llm_service(self) -> LLMService:
        """LLMサービスを取得"""
        if self._llm_service is None:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")
        return self._llm_service

    @property
    def graph(self) -> TeporaGraph:
        """グラフを取得"""
        if self._graph is None:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")
        return self._graph

    def get_memory_stats(self) -> dict:
        """
        V1互換: メモリ統計を取得

        Returns:
            メモリ統計辞書
        """
        if not self._initialized:
            return {"error": "not_initialized"}
        return {
            "status": "v2",
            "sessions": len(self.session_manager.list_active_sessions()),
            "tools_loaded": len(self._tool_manager.tools) if self._tool_manager else 0,
        }

    async def initialize(
        self,
        mcp_hub=None,
        download_manager: DownloadManager | None = None,
    ) -> bool:
        """
        全コンポーネントを初期化

        Args:
            mcp_hub: MCPハブ（オプション）
            download_manager: ダウンロードマネージャー（オプション）

        Returns:
            初期化成功時True

        この順序で初期化されます:
        1. Logging
        2. Session Manager
        3. Tool Manager
        4. LLM Service
        5. Context Manager
        6. RAG Engine & Context Builder
        7. Graph
        """
        if self._initialized:
            logger.warning("TeporaApp is already initialized.")
            return True

        logger.info("Initializing TeporaApp V2...")

        # 外部依存性を保存
        self._download_manager = download_manager
        self._mcp_hub = mcp_hub

        # 1. Logging設定
        if self.config.log_dir:
            setup_logging(
                log_dir=self.config.log_dir,
                level=self.config.log_level,
                pii_redaction=self.config.pii_redaction,
            )

        # 2. Session Manager
        self._session_manager = SessionManager()
        logger.debug("SessionManager initialized.")

        # 3. Tool Manager
        self._tool_manager = ToolManager(
            providers=self.config.tool_providers,
            tool_timeout=self.config.tool_timeout,
        )
        self._tool_manager.initialize()
        logger.debug("ToolManager initialized with %d tools.", len(self._tool_manager.tools))

        # 4. LLM Service
        self._llm_service = LLMService(
            download_manager=self._download_manager,
            model_manager=self._model_manager,
        )
        logger.debug("LLMService initialized (stateless mode).")

        # 5. Context Manager
        self._context_manager = ContextWindowManager()
        logger.debug("ContextWindowManager initialized.")

        # 6. RAG Engine & Context Builder
        self._rag_engine = RAGEngine()
        self._context_builder = RAGContextBuilder()
        logger.debug("RAG Engine and Context Builder initialized.")

        # 7. Graph
        self._graph = TeporaGraph(
            llm_service=self._llm_service,
            context_manager=self._context_manager,
            rag_engine=self._rag_engine,
            context_builder=self._context_builder,
            tool_manager=self._tool_manager,
        )
        logger.debug("TeporaGraph initialized.")

        self._initialized = True
        logger.info("TeporaApp V2 initialized successfully (Phase 4 complete).")
        return True

    async def process_message(
        self,
        session_id: str,
        message: str,
        *,
        mode: str = "direct",
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        メッセージを処理し、ストリーミング応答を返す

        Args:
            session_id: セッションID
            message: ユーザーメッセージ
            mode: 処理モード ("direct", "search", "agent")
            **kwargs: 追加パラメータ

        Yields:
            応答チャンク

        Raises:
            RuntimeError: 初期化されていない場合
        """
        if not self._initialized:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")

        # セッションリソース取得
        _resources = self.session_manager.get_session_resources(session_id)
        logger.info("Processing message for session %s (mode=%s)", session_id, mode)

        # Graph経由でメッセージ処理
        assert self._graph is not None  # Guaranteed by _initialized check
        async for chunk in self._graph.process(
            session_id=session_id,
            message=message,
            mode=mode,
            **kwargs,
        ):
            yield chunk

    async def execute_tool(self, tool_name: str, tool_args: dict[str, Any]) -> str | Any:
        """
        ツールを実行

        Args:
            tool_name: ツール名
            tool_args: ツール引数

        Returns:
            ツール実行結果
        """
        if not self._initialized:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")

        assert self._tool_manager is not None  # Guaranteed by _initialized check
        return await self._tool_manager.aexecute_tool(tool_name, tool_args)

    async def shutdown(self) -> None:
        """
        リソースをクリーンアップ

        この順序で終了処理されます:
        1. Graph
        2. LLM Service
        3. Tool Manager
        4. Session Manager
        """
        if not self._initialized:
            logger.warning("TeporaApp was not initialized.")
            return

        logger.info("Shutting down TeporaApp V2...")

        # Graph (Phase 3)
        if self._graph:
            self._graph.cleanup()
            logger.debug("TeporaGraph cleaned up.")

        # LLM Service (Phase 2)
        if self._llm_service:
            self._llm_service.cleanup()
            logger.debug("LLMService cleaned up.")

        # Tool Manager
        if self._tool_manager:
            self._tool_manager.cleanup()
            logger.debug("ToolManager cleaned up.")

        # Session Manager
        if self._session_manager:
            for session_id in self._session_manager.list_active_sessions():
                self._session_manager.release_session(session_id)
            logger.debug("SessionManager cleaned up.")

        self._initialized = False
        logger.info("TeporaApp V2 shut down successfully.")

    # Context Manager support
    async def __aenter__(self) -> TeporaApp:
        await self.initialize()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.shutdown()

    # --- V1互換 API ---

    async def process_user_request(
        self,
        user_input: str,
        mode: str = "direct",
        attachments: list[dict] | None = None,
        skip_web_search: bool = False,
        session_id: str = "default",
        approval_callback=None,
    ):
        """
        V1互換: ユーザーリクエストを処理する

        Args:
            user_input: ユーザー入力
            mode: 処理モード (direct, search, agent)
            attachments: 添付ファイルリスト
            skip_web_search: Web検索をスキップするか
            session_id: セッションID
            approval_callback: ツール承認コールバック

        Yields:
            イベント辞書
        """
        if not self._initialized:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")

        logger.info(
            "V1 compat: process_user_request session=%s mode=%s",
            session_id,
            mode,
        )

        # V2のprocess_messageを呼び出し、V1形式のイベントに変換
        async for chunk in self.process_message(
            session_id=session_id,
            message=user_input,
            mode=mode,
            skip_web_search=skip_web_search,
        ):
            # V1形式のイベントとして返す
            yield {
                "event": "on_chat_model_stream",
                "data": {"chunk": type("Chunk", (), {"content": chunk})()},
            }

    async def cleanup(self) -> None:
        """V1互換: リソースクリーンアップ（shutdownのエイリアス）"""
        await self.shutdown()
