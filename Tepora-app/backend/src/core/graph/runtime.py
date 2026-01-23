"""
TeporaGraph Runtime - Main Router and Orchestrator

Main graph runtime that routes between chat, search, and agent modes.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from langgraph.graph import END, StateGraph

from .constants import GraphNodes, GraphRoutes, InputMode
from .nodes import ChatNode, SearchNode
from .state import AgentState, create_initial_state

if TYPE_CHECKING:
    from src.core.context import ContextWindowManager
    from src.core.llm import LLMService
    from src.core.rag import RAGContextBuilder, RAGEngine
    from src.core.tools import ToolManager

logger = logging.getLogger(__name__)


class TeporaGraph:
    """
    Main graph runtime for V2 architecture.

    Routes between:
    - chat (direct): Simple Q&A
    - search: Web search with RAG
    - agent: ReAct loop (skeleton in Phase 3)

    Usage:
        graph = TeporaGraph(
            llm_service=llm_service,
            context_manager=context_manager,
            rag_engine=rag_engine,
            context_builder=context_builder,
            tool_manager=tool_manager,
        )

        async for chunk in graph.process("session-1", "Hello!", mode="chat"):
            print(chunk, end="")
    """

    def __init__(
        self,
        llm_service: LLMService,
        context_manager: ContextWindowManager,
        rag_engine: RAGEngine,
        context_builder: RAGContextBuilder,
        tool_manager: ToolManager | None = None,
    ):
        """
        Initialize TeporaGraph.

        Args:
            llm_service: LLM service for model access
            context_manager: Context window manager
            rag_engine: RAG engine for chunk collection
            context_builder: RAG context builder
            tool_manager: Tool manager (optional, for agent mode)
        """
        self.llm_service = llm_service
        self.context_manager = context_manager
        self.rag_engine = rag_engine
        self.context_builder = context_builder
        self.tool_manager = tool_manager

        # Initialize nodes
        self._chat_node = ChatNode(
            llm_service=llm_service,
            context_manager=context_manager,
        )
        self._search_node = SearchNode(
            llm_service=llm_service,
            context_manager=context_manager,
            rag_engine=rag_engine,
            context_builder=context_builder,
        )

        # Build compiled graph
        self._graph = self._build_graph()

        logger.info("TeporaGraph initialized")

    def _build_graph(self):
        """Build and compile the LangGraph workflow."""
        workflow = StateGraph(AgentState)

        # Register nodes
        workflow.add_node(GraphNodes.DIRECT_ANSWER, self._direct_answer_wrapper)
        workflow.add_node(
            GraphNodes.SUMMARIZE_SEARCH_RESULT,
            self._summarize_search_wrapper,
        )

        # Entry point with router
        workflow.set_conditional_entry_point(
            self._route_by_mode,
            {
                GraphRoutes.DIRECT_ANSWER: GraphNodes.DIRECT_ANSWER,
                GraphRoutes.SEARCH: GraphNodes.SUMMARIZE_SEARCH_RESULT,
                # Agent mode falls through to direct for now (Phase 3 skeleton)
                GraphRoutes.AGENT_MODE: GraphNodes.DIRECT_ANSWER,
            },
        )

        # All paths end
        workflow.add_edge(GraphNodes.DIRECT_ANSWER, END)
        workflow.add_edge(GraphNodes.SUMMARIZE_SEARCH_RESULT, END)

        logger.info("Graph construction complete")
        return workflow.compile()

    def _route_by_mode(self, state: AgentState) -> str:
        """Route based on input mode."""
        mode = state.get("mode", "direct")

        if mode == InputMode.SEARCH or mode == "search":
            return GraphRoutes.SEARCH
        elif mode == InputMode.AGENT or mode == "agent":
            # Phase 3 skeleton: agent mode falls back to direct
            logger.info("Agent mode requested (Phase 3 skeleton -> direct answer)")
            return GraphRoutes.AGENT_MODE
        else:
            return GraphRoutes.DIRECT_ANSWER

    async def _direct_answer_wrapper(self, state: AgentState) -> dict[str, Any]:
        """Wrapper for chat node."""
        # TODO: Get persona/prompt from config
        return await self._chat_node.direct_answer_node(
            state,
            persona="",
            system_prompt="",
        )

    async def _summarize_search_wrapper(self, state: AgentState) -> dict[str, Any]:
        """Wrapper for search node."""
        tool_executor = None
        if self.tool_manager:
            tool_executor = self.tool_manager.aexecute_tool

        return await self._search_node.summarize_search_result_node(
            state,
            persona="",
            system_template="",
            tool_executor=tool_executor,
        )

    async def process(
        self,
        session_id: str,
        message: str,
        *,
        mode: str = "direct",
        chat_history: list | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Process a message and stream response.

        Args:
            session_id: Session identifier
            message: User message
            mode: Processing mode (direct, search, agent)
            chat_history: Existing chat history
            **kwargs: Additional state fields

        Yields:
            Response text chunks
        """
        logger.info(
            "Processing message for session %s (mode=%s)",
            session_id,
            mode,
        )

        # Create initial state
        state = create_initial_state(
            session_id=session_id,
            user_input=message,
            mode=mode,
            chat_history=chat_history,
        )

        # Add any additional kwargs to state
        for key, value in kwargs.items():
            if key in state:
                state[key] = value

        # Use streaming nodes directly for better control
        if mode == "search":
            tool_executor = None
            if self.tool_manager:
                tool_executor = self.tool_manager.aexecute_tool

            async for chunk in self._search_node.stream_search_summary(
                state,
                persona="",
                system_template="",
                tool_executor=tool_executor,
            ):
                yield chunk
        else:
            # Default to direct answer
            async for chunk in self._chat_node.stream_direct_answer(
                state,
                persona="",
                system_prompt="",
            ):
                yield chunk

    async def invoke(
        self,
        session_id: str,
        message: str,
        *,
        mode: str = "direct",
        chat_history: list | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """
        Process a message and return full result.

        Args:
            session_id: Session identifier
            message: User message
            mode: Processing mode
            chat_history: Existing chat history
            **kwargs: Additional state fields

        Returns:
            Final agent state
        """
        state = create_initial_state(
            session_id=session_id,
            user_input=message,
            mode=mode,
            chat_history=chat_history,
        )

        for key, value in kwargs.items():
            if key in state:
                state[key] = value

        result = await self._graph.ainvoke(state)
        return result

    def cleanup(self) -> None:
        """Cleanup graph resources."""
        logger.info("TeporaGraph cleanup complete")
