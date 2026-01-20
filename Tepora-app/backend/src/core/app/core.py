"""
Core application logic for Tepora Agent.
Shared between CLI and Web interfaces.
"""

import base64
import logging
import re
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph.state import CompiledStateGraph as CompiledGraph

from .. import config
from ..chat_history_manager import ChatHistoryManager
from ..config import (
    CHROMA_DB_PATH,
    DEFAULT_HISTORY_LIMIT,
    PROJECT_ROOT,
    STREAM_EVENT_CHAT_MODEL,
    STREAM_EVENT_GRAPH_END,
)
from ..em_llm import EMConfig, EMLLMIntegrator
from ..embedding_provider import EmbeddingProvider
from ..graph import AgentCore, EMEnabledAgentCore
from ..graph.constants import InputMode
from ..llm_manager import LLMManager
from ..memory.memory_system import MemorySystem
from ..tool_manager import ToolManager
from .utils import sanitize_user_input

if TYPE_CHECKING:
    from ..mcp.hub import McpHub

# Base64 pattern for detection (standard base64 with optional padding)
BASE64_PATTERN = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")

logger = logging.getLogger(__name__)


class TeporaCoreApp:
    """
    Core application class that manages the business logic of the agent.
    Independent of the user interface (CLI/Web).
    """

    def __init__(self):
        self.llm_manager: LLMManager | None = None
        self.tool_manager: ToolManager | None = None
        self.embedding_provider: EmbeddingProvider | None = None
        self.char_em_llm_integrator: EMLLMIntegrator | None = None
        self.prof_em_llm_integrator: EMLLMIntegrator | None = None
        self.history_manager: ChatHistoryManager | None = None
        self.app: CompiledGraph | None = None  # The compiled graph
        self.initialized = False

    @staticmethod
    def _try_decode_base64(content: str) -> str | None:
        if len(content) <= 100:
            return None

        content_stripped = content.replace("\n", "").replace("\r", "")
        if not BASE64_PATTERN.match(content_stripped):
            return None

        try:
            decoded_bytes = base64.b64decode(content_stripped)
            return decoded_bytes.decode("utf-8")
        except Exception:
            return None

    def _process_attachments(self, attachments: list[dict]) -> list[dict]:
        processed_attachments = []
        safe_limit = int(config.SEARCH_ATTACHMENT_SIZE_LIMIT * 1.35)

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
                        processed_attachments.append(
                            {
                                "name": attachment_name,
                                "content": decoded_text,
                                "type": att.get("type"),
                            }
                        )
                        continue

                processed_attachments.append(att)
            except Exception as e:
                logger.warning(
                    "Failed to decode attachment %s: %s", attachment_name, e, exc_info=True
                )
                processed_attachments.append(att)

        return processed_attachments

    async def initialize(self, mcp_hub: "McpHub | None" = None, download_manager=None) -> bool:
        """Initialize all core components."""
        try:
            logger.info("Initializing Core Systems...")

            # 0. Startup configuration is validated externally (fail-fast) by app factory.

            # 1. LLM Manager
            # Use shared download_manager if provided, otherwise create new
            if download_manager is None:
                try:
                    from ..download.manager import DownloadManager

                    download_manager = DownloadManager()
                    logger.info("DownloadManager initialized for LLMManager context.")
                except ImportError:
                    logger.warning(
                        "Could not import DownloadManager. LLMManager will use fallback paths."
                    )

            self.llm_manager = LLMManager(download_manager=download_manager)
            logger.info("LLMManager for Llama.cpp initialized.")

            # 2. Tool Manager
            from ..tools.mcp import McpToolProvider
            from ..tools.native import NativeToolProvider

            tool_config_path = PROJECT_ROOT / "config" / "mcp_tools_config.json"
            providers = [
                NativeToolProvider(),
                McpToolProvider(config_path=tool_config_path, hub=mcp_hub),
            ]
            self.tool_manager = ToolManager(providers=providers)
            self.tool_manager.initialize()
            logger.info(
                "ToolManager initialized with providers: %s",
                [p.__class__.__name__ for p in providers],
            )

            # 3. History Manager
            self.history_manager = ChatHistoryManager()
            logger.info("ChatHistoryManager initialized.")

            # 4. EM-LLM Systems
            await self._initialize_memory_systems()

            # 5. Application Graph
            await self._build_graph()

            self.initialized = True
            logger.info("Core initialization complete.")
            return True

        except Exception as e:
            logger.error("Core initialization failed: %s", e, exc_info=True)
            return False

    async def _initialize_memory_systems(self):
        """Initialize EM-LLM memory systems."""
        try:
            # Embedding Provider
            embedding_llm = await self.llm_manager.get_embedding_model()
            self.embedding_provider = EmbeddingProvider(embedding_llm)

            # EM Config
            em_config = EMConfig(**config.EM_LLM_CONFIG)

            # Character Memory
            char_db_path = CHROMA_DB_PATH / "em_llm"
            char_em_memory_system = MemorySystem(
                self.embedding_provider,
                db_path=str(char_db_path),
                collection_name="em_llm_events_char",
            )
            self.char_em_llm_integrator = EMLLMIntegrator(
                self.llm_manager, self.embedding_provider, em_config, char_em_memory_system
            )

            # Professional Memory
            prof_db_path = CHROMA_DB_PATH / "em_llm"
            prof_em_memory_system = MemorySystem(
                self.embedding_provider,
                db_path=str(prof_db_path),
                collection_name="em_llm_events_prof",
            )
            self.prof_em_llm_integrator = EMLLMIntegrator(
                self.llm_manager, self.embedding_provider, em_config, prof_em_memory_system
            )

        except Exception as e:
            logger.error("EM-LLM initialization failed (System degraded): %s", e, exc_info=True)
            self.char_em_llm_integrator = None
            self.prof_em_llm_integrator = None
            # Fallback logic is handled in _build_graph

    async def _build_graph(self):
        """Build the LangGraph application."""
        if self.char_em_llm_integrator and self.prof_em_llm_integrator:
            # EM-LLM Enabled
            agent_core = EMEnabledAgentCore(
                self.llm_manager,
                self.tool_manager,
                self.char_em_llm_integrator,
                self.prof_em_llm_integrator,
            )
        else:
            # Fallback
            memory_system = None
            if self.embedding_provider:
                try:
                    fallback_db_path = CHROMA_DB_PATH / "fallback"
                    memory_system = MemorySystem(
                        self.embedding_provider, db_path=str(fallback_db_path)
                    )
                except Exception as e:
                    logger.error("Fallback memory init failed: %s", e, exc_info=True)

            agent_core = AgentCore(self.llm_manager, self.tool_manager, memory_system)

        self.app = agent_core.graph

    async def process_input(
        self,
        user_input: str,
        chat_history: list,
        mode: str = "direct",
        search_metadata: dict | None = None,
        approval_callback: Callable[[str, dict], Awaitable[bool]] | None = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Process user input and yield events from the graph.

        Args:
            approval_callback: Optional async callback for tool approval (tool_name, args) -> bool
        """
        if not self.app:
            raise RuntimeError("App not initialized")

        initial_state = {
            "input": user_input,
            "mode": mode,
            "chat_history": chat_history,
            "agent_scratchpad": [],
            "messages": [],
        }

        if search_metadata:
            initial_state.update(search_metadata)

        # Build config with optional approval callback
        run_config = {"recursion_limit": config.GRAPH_RECURSION_LIMIT, "configurable": {}}
        if approval_callback:
            run_config["configurable"]["approval_callback"] = approval_callback

        async for event in self.app.astream_events(initial_state, version="v2", config=run_config):
            yield event

    async def process_user_request(
        self,
        user_input: str,
        mode: str = "direct",
        attachments: list[dict] | None = None,
        skip_web_search: bool = False,
        session_id: str = "default",
        approval_callback: Callable[[str, dict], Awaitable[bool]] | None = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Full pipeline for processing a user request:
        1. Sanitize input
        2. Process attachments
        3. Prepare search metadata
        4. Run graph
        5. Update history

        Args:
            session_id: The session ID for chat history isolation
            approval_callback: Optional async callback for tool approval
        """
        if attachments is None:
            attachments = []

        # 1. Sanitize
        try:
            user_input_sanitized = sanitize_user_input(user_input)
        except ValueError as e:
            logger.warning("Input sanitization failed: %s", e)
            raise

        # 2. Determine Mode & Clean Input
        # Default to the passed 'mode' argument (from API/UI)
        final_mode = mode
        user_input_processed = user_input_sanitized

        # 3. Process Attachments
        processed_attachments = self._process_attachments(attachments)

        # 4. Search Metadata & Mode
        search_metadata: dict[str, Any] = {}
        # mode logic for search metdata
        if final_mode == InputMode.SEARCH:
            if not config.settings.privacy.allow_web_search:
                if not skip_web_search:
                    logger.info("Web search disabled by privacy settings; skipping search.")
                skip_web_search = True
            if processed_attachments:
                search_metadata["search_attachments"] = processed_attachments
            if skip_web_search:
                search_metadata["skip_web_search"] = True

        # 5. Get History for this session
        if self.history_manager is None:
            raise RuntimeError("history_manager not initialized")
        recent_history = self.history_manager.get_history(
            session_id=session_id, limit=DEFAULT_HISTORY_LIMIT
        )

        # 6. Process
        full_response = ""
        final_state = None

        async for event in self.process_input(
            user_input_processed,
            recent_history,
            mode=final_mode,
            search_metadata=search_metadata,
            approval_callback=approval_callback,
        ):
            kind = event["event"]
            if kind == STREAM_EVENT_CHAT_MODEL:
                chunk = event["data"]["chunk"]
                if chunk.content:
                    full_response += chunk.content
            elif kind == STREAM_EVENT_GRAPH_END:
                final_state = event["data"]["output"]

            yield event

        # 7. Update History for this session
        if final_state:
            final_history = final_state.get("chat_history")
            if final_history:
                self.history_manager.overwrite_history(final_history, session_id=session_id)
        else:
            self.history_manager.add_messages(
                [
                    HumanMessage(content=user_input_processed),
                    AIMessage(content=full_response),
                ],
                session_id=session_id,
            )

        # Touch session to update updated_at timestamp
        self.history_manager.touch_session(session_id)
        self.history_manager.trim_history(session_id=session_id, keep_last_n=1000)

    def get_memory_stats(self) -> dict[str, Any]:
        """Get statistics for memory systems."""
        stats: dict[str, Any] = {"char_memory": {}, "prof_memory": {}}

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

    async def cleanup(self):
        """Cleanup resources."""
        if self.llm_manager:
            self.llm_manager.cleanup()
        if self.tool_manager:
            self.tool_manager.cleanup()
        for integrator in (self.char_em_llm_integrator, self.prof_em_llm_integrator):
            if integrator:
                try:
                    integrator.memory_system.close()
                except Exception as e:
                    logger.warning("Failed to close memory system: %s", e, exc_info=True)
