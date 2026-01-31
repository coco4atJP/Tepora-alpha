"""
TeporaApp - V2 Application Facade

アプリケーションのメインエントリポイント。
全てのV2コンポーネントを統合し、統一されたAPIを提供します。

使用例:
    from src.core.app_v2 import TeporaApp

    app = TeporaApp()
    await app.initialize()

    async for chunk in app.process_message("session-1", "Hello!"):
        print(chunk, end="")

    await app.shutdown()
"""

from __future__ import annotations

import base64
import binascii
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, cast

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from src.core.models import ModelManager

from . import config as core_config
from .app.utils import sanitize_user_input
from .chat_history_manager import ChatHistoryManager
from .context import ContextWindowManager
from .graph import TeporaGraph
from .graph.constants import InputMode
from .graph.routing import extract_routing_tag
from .graph.state import create_initial_state
from .llm import LLMService
from .rag import RAGContextBuilder, RAGEngine
from .system import SessionManager, get_logger, setup_logging
from .tools import ToolManager, ToolProvider

if TYPE_CHECKING:
    from pathlib import Path

    from src.core.download import DownloadManager
    from src.core.models import ModelManager


logger = get_logger(__name__)

# Base64 pattern for detection (standard base64 with optional padding)
_BASE64_PATTERN = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


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
        self._history_manager: ChatHistoryManager | None = None

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

        # --- V1互換フィールド（API/FEが参照するため維持） ---
        from .em_llm import EMLLMIntegrator

        self.char_em_llm_integrator: EMLLMIntegrator | None = None
        self.prof_em_llm_integrator: EMLLMIntegrator | None = None

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

        V1ではChatHistoryManagerを返していたため、V2でも同一の公開APIを維持する。
        """
        return self._history_manager

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
        stats: dict[str, Any] = {"char_memory": {}, "prof_memory": {}}

        if not self._initialized:
            return {"error": "not_initialized", **stats}

        if self.char_em_llm_integrator:
            try:
                stats["char_memory"] = self.char_em_llm_integrator.get_memory_statistics()
            except Exception as e:
                logger.error("Failed to get char memory stats: %s", e, exc_info=True)
                stats["char_memory"] = {"error": str(e)}

        if self.prof_em_llm_integrator:
            try:
                stats["prof_memory"] = self.prof_em_llm_integrator.get_memory_statistics()
            except Exception as e:
                logger.error("Failed to get prof memory stats: %s", e, exc_info=True)
                stats["prof_memory"] = {"error": str(e)}

        return stats

    @staticmethod
    def _try_decode_base64(content: str) -> str | None:
        if len(content) <= 100:
            return None

        stripped = content.replace("\n", "").replace("\r", "")
        if not _BASE64_PATTERN.match(stripped):
            return None

        try:
            decoded_bytes = base64.b64decode(stripped)
            return decoded_bytes.decode("utf-8")
        except (binascii.Error, ValueError, UnicodeDecodeError):
            return None

    def _process_attachments(self, attachments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        processed: list[dict[str, Any]] = []
        safe_limit = int(core_config.SEARCH_ATTACHMENT_SIZE_LIMIT * 1.35)

        for att in attachments:
            if not isinstance(att, dict):
                logger.warning("Skipping non-dict attachment: %s", type(att).__name__)
                continue

            attachment_name = att.get("name")
            try:
                content = att.get("content", "")

                # Security: Check size limit FIRST for ALL content types
                if isinstance(content, str) and len(content) > safe_limit:
                    logger.warning(
                        "Attachment '%s' skipped: Size %d exceeds limit %d",
                        attachment_name,
                        len(content),
                        safe_limit,
                    )
                    continue

                if isinstance(content, str):
                    decoded_text = self._try_decode_base64(content)
                    if decoded_text is not None:
                        processed.append(
                            {
                                "name": attachment_name,
                                "path": att.get("path"),
                                "content": decoded_text,
                                "type": att.get("type"),
                            }
                        )
                        continue

                processed.append(att)
            except Exception as e:
                # We catch generic Exception here because attachment processing handles
                # untrusted user input and can fail in unpredictable ways (e.g. malformed data).
                # We log the error but allow processing to continue for other attachments.
                logger.warning(
                    "Failed to decode attachment %s: %s", attachment_name, e, exc_info=True
                )
                processed.append(att)

        return processed

    async def _initialize_em_llm_integrators(self) -> None:
        """Initialize EM-LLM integrators (best-effort)."""
        try:
            from .em_llm import EMConfig, EMLLMIntegrator
            from .embedding_provider import EmbeddingProvider
            from .memory.memory_system import MemorySystem

            if self._llm_service is None:
                raise RuntimeError("LLMService not initialized")

            embedding_llm = await self._llm_service.get_embedding_client()
            embedding_provider = EmbeddingProvider(embedding_llm)

            em_config = EMConfig(**core_config.EM_LLM_CONFIG)

            char_db_path = core_config.CHROMA_DB_PATH / "em_llm"
            char_memory_system = MemorySystem(
                embedding_provider,
                db_path=str(char_db_path),
                collection_name="em_llm_events_char",
            )

            prof_db_path = core_config.CHROMA_DB_PATH / "em_llm"
            prof_memory_system = MemorySystem(
                embedding_provider,
                db_path=str(prof_db_path),
                collection_name="em_llm_events_prof",
            )

            self.char_em_llm_integrator = EMLLMIntegrator(
                self._llm_service,
                embedding_provider,
                em_config,
                char_memory_system,
            )
            self.prof_em_llm_integrator = EMLLMIntegrator(
                self._llm_service,
                embedding_provider,
                em_config,
                prof_memory_system,
            )

            logger.info("EM-LLM integrators initialized.")

        except ImportError as e:
            logger.warning(
                "EM-LLM initialization skipped: Missing required dependencies (%s). "
                "This is expected if EM-LLM features are not installed.",
                e,
            )
            self.char_em_llm_integrator = None
            self.prof_em_llm_integrator = None
        except RuntimeError as e:
            logger.error("EM-LLM initialization failed due to configuration error: %s", e)
            self.char_em_llm_integrator = None
            self.prof_em_llm_integrator = None
        except Exception as e:
            logger.error(
                "EM-LLM initialization failed unexpectedly (system degraded): %s",
                e,
                exc_info=True,
            )
            self.char_em_llm_integrator = None
            self.prof_em_llm_integrator = None

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

        # Logging configuration
        if self.config.log_dir:
            setup_logging(
                log_dir=self.config.log_dir,
                level=self.config.log_level,
                pii_redaction=self.config.pii_redaction,
            )

        # Session Manager initialization
        self._session_manager = SessionManager()
        logger.debug("SessionManager initialized.")

        # History Manager (SQLite) initialization
        self._history_manager = ChatHistoryManager()
        logger.debug("ChatHistoryManager initialized.")

        # Tool Manager initialization (default providers if none configured)
        providers = list(self.config.tool_providers)
        if not providers:
            from .mcp.paths import ensure_mcp_config_exists, resolve_mcp_config_path
            from .tools.mcp import McpToolProvider
            from .tools.native import NativeToolProvider

            tool_config_path = (
                mcp_hub.config_path if mcp_hub is not None else resolve_mcp_config_path()
            )
            ensure_mcp_config_exists(tool_config_path)
            providers = [
                NativeToolProvider(),
                McpToolProvider(config_path=tool_config_path, hub=mcp_hub),
            ]

        self._tool_manager = ToolManager(providers=providers, tool_timeout=self.config.tool_timeout)
        self._tool_manager.initialize()
        logger.debug("ToolManager initialized with %d tools.", len(self._tool_manager.tools))

        # Model Manager initialization
        from pathlib import Path

        if not self._model_manager:
            if self._download_manager is not None:
                self._model_manager = self._download_manager.model_manager
                logger.debug("ModelManager initialized from DownloadManager.")
            else:
                self._model_manager = ModelManager(models_dir=Path(core_config.MODEL_BASE_PATH))
                logger.debug("ModelManager initialized.")

        # LLM Service initialization
        self._llm_service = LLMService(
            download_manager=self._download_manager,
            model_manager=self._model_manager,
        )
        logger.debug("LLMService initialized (stateless mode).")

        # Context Manager initialization
        self._context_manager = ContextWindowManager()
        logger.debug("ContextWindowManager initialized.")

        # RAG Engine & Context Builder initialization
        self._rag_engine = RAGEngine()
        self._context_builder = RAGContextBuilder()
        logger.debug("RAG Engine and Context Builder initialized.")

        # EM-LLM (best-effort) initialization
        await self._initialize_em_llm_integrators()

        # Graph initialization (full pipeline)
        self._graph = TeporaGraph(
            llm_service=self._llm_service,
            context_manager=self._context_manager,
            rag_engine=self._rag_engine,
            context_builder=self._context_builder,
            tool_manager=self._tool_manager,
            char_em_llm_integrator=self.char_em_llm_integrator,
            prof_em_llm_integrator=self.prof_em_llm_integrator,
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
        mode: str = "chat",
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        メッセージを処理し、ストリーミング応答を返す

        Args:
            session_id: セッションID
            message: ユーザーメッセージ
            mode: 処理モード ("chat", "search", "agent")
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

        chat_history = []
        if self._history_manager is not None:
            chat_history = self._history_manager.get_history(
                session_id=session_id,
                limit=core_config.DEFAULT_HISTORY_LIMIT,
            )

        # Graph経由でメッセージ処理
        assert self._graph is not None  # Guaranteed by _initialized check
        async for chunk in self._graph.process(
            session_id=session_id,
            message=message,
            mode=mode,
            chat_history=chat_history,
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

        # EM-LLM memory systems
        for integrator in (self.char_em_llm_integrator, self.prof_em_llm_integrator):
            if integrator:
                try:
                    integrator.memory_system.close()
                except Exception as e:  # noqa: BLE001
                    logger.warning("Failed to close memory system: %s", e, exc_info=True)

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
        mode: str = "chat",
        attachments: list[dict] | None = None,
        skip_web_search: bool = False,
        session_id: str = "default",
        approval_callback: Callable[[str, dict], Awaitable[bool]] | None = None,
        **kwargs: Any,
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
            **kwargs: 追加パラメータ（thinking_mode等）

        Yields:
            イベント辞書
        """
        if not self._initialized:
            raise RuntimeError("TeporaApp not initialized. Call initialize() first.")

        if attachments is None:
            attachments = []

        logger.info("process_user_request session=%s mode=%s", session_id, mode)

        # Sanitize
        user_input_sanitized = sanitize_user_input(user_input)

        # Extract routing tags (XML-style) for agent mode overrides
        user_input_sanitized, tag_agent_mode = extract_routing_tag(user_input_sanitized)

        # Process attachments (best-effort; only used in Search mode)
        processed_attachments = self._process_attachments(attachments)

        # Prepare search metadata
        search_metadata: dict[str, Any] = {}
        final_mode = mode
        agent_mode = kwargs.pop("agent_mode", None) or kwargs.pop("agentMode", None)

        if tag_agent_mode:
            final_mode = InputMode.AGENT
            agent_mode = tag_agent_mode

        if final_mode == InputMode.AGENT and not agent_mode:
            agent_mode = "fast"
        if final_mode == InputMode.SEARCH or final_mode == "search":
            if not core_config.settings.privacy.allow_web_search:
                if not skip_web_search:
                    logger.info("Web search disabled by privacy settings; forcing skip_web_search.")
                skip_web_search = True

            if processed_attachments:
                search_metadata["search_attachments"] = processed_attachments
            if skip_web_search:
                search_metadata["skip_web_search"] = True
            # Keep an explicit copy for prompts that use search_query separately.
            search_metadata["search_query"] = user_input_sanitized

        # Get history
        if self._history_manager is None:
            raise RuntimeError("history_manager not initialized")

        recent_history = self._history_manager.get_history(
            session_id=session_id, limit=core_config.DEFAULT_HISTORY_LIMIT
        )

        # Run graph and stream events
        initial_state = create_initial_state(
            session_id=session_id,
            user_input=user_input_sanitized,
            mode=final_mode,
            chat_history=recent_history,
        )
        # Use cast to satisfy MyPy for dynamic TypedDict assignment
        for key, value in search_metadata.items():
            if key in initial_state:
                cast(dict, initial_state)[key] = value

        if agent_mode:
            kwargs["agent_mode"] = agent_mode

        for key, value in kwargs.items():
            if key in initial_state:
                cast(dict, initial_state)[key] = value

        run_config_typed: RunnableConfig = cast(
            RunnableConfig,
            {
                "recursion_limit": core_config.GRAPH_RECURSION_LIMIT,
                "configurable": {},
            },
        )
        if approval_callback:
            if "configurable" not in run_config_typed:
                run_config_typed["configurable"] = {}  # type: ignore
            run_config_typed["configurable"]["approval_callback"] = approval_callback

        full_response = ""
        final_state = None

        assert self._graph is not None
        async for event in self._graph.astream_events(initial_state, run_config=run_config_typed):
            kind = event.get("event")
            if kind == core_config.STREAM_EVENT_CHAT_MODEL:
                chunk = (event.get("data") or {}).get("chunk")
                if chunk is not None and getattr(chunk, "content", None):
                    full_response += str(chunk.content)
            elif kind == core_config.STREAM_EVENT_GRAPH_END:
                final_state = (event.get("data") or {}).get("output")

            yield event

        # Update history (keep mode + timestamp)
        now_iso = datetime.now().isoformat()

        def _annotate_message(msg, *, msg_mode: str):
            if not hasattr(msg, "copy"):
                return msg
            kwargs = (
                msg.additional_kwargs
                if isinstance(getattr(msg, "additional_kwargs", None), dict)
                else {}
            )
            merged = {**kwargs}
            merged.setdefault("mode", msg_mode)
            merged.setdefault("timestamp", now_iso)
            return msg.copy(update={"additional_kwargs": merged})

        if isinstance(final_state, dict) and final_state.get("chat_history"):
            final_history = list(final_state["chat_history"])
            # Annotate only the tail messages from this request (best effort).
            tail_start = max(0, len(final_history) - 2)
            for idx in range(tail_start, len(final_history)):
                final_history[idx] = _annotate_message(final_history[idx], msg_mode=str(final_mode))
            self._history_manager.overwrite_history(final_history, session_id=session_id)
        else:
            self._history_manager.add_messages(
                [
                    HumanMessage(
                        content=user_input_sanitized,
                        additional_kwargs={"mode": str(final_mode), "timestamp": now_iso},
                    ),
                    AIMessage(
                        content=full_response,
                        additional_kwargs={"mode": str(final_mode), "timestamp": now_iso},
                    ),
                ],
                session_id=session_id,
            )

        self._history_manager.touch_session(session_id)
        self._history_manager.trim_history(session_id=session_id, keep_last_n=1000)

    async def cleanup(self) -> None:
        """V1互換: リソースクリーンアップ（shutdownのエイリアス）"""
        await self.shutdown()
