"""
TeporaGraph Runtime - Main Router and Orchestrator

Main graph runtime that routes between chat, search, and agent modes,
and integrates EM-LLM memory retrieval/formation.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, StateGraph

from .. import config
from ..agent.registry import custom_agent_registry
from ..config.schema import CustomAgentConfig, CustomAgentToolPolicy
from .constants import GraphNodes, GraphRoutes
from .nodes.chat import ChatNode
from .nodes.custom_agent import CustomAgentNode
from .nodes.em_llm import EMMemoryNodes
from .nodes.react import ReActNodes
from .nodes.search import SearchNode
from .nodes.search_pipeline import SearchPipelineNodes
from .nodes.supervisor import SupervisorNode
from .nodes.thinking import ThinkingNode
from .routing import route_by_command, route_from_supervisor
from .state import AgentState, create_initial_state

if TYPE_CHECKING:
    from src.core.context import ContextWindowManager
    from src.core.em_llm import EMLLMIntegrator
    from src.core.llm import LLMService
    from src.core.rag import RAGContextBuilder, RAGEngine
    from src.core.tools import ToolManager

logger = logging.getLogger(__name__)


class TeporaGraph:
    """
    Main graph runtime for V2 architecture.

    Routes between:
    - chat: Simple Q&A (formerly direct)
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
        *,
        char_em_llm_integrator: EMLLMIntegrator | None = None,
        prof_em_llm_integrator: EMLLMIntegrator | None = None,
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

        # Node implementations (V2)
        self._chat_node = ChatNode(llm_service=llm_service, context_manager=context_manager)
        self._search_node = SearchNode(
            llm_service=llm_service,
            context_manager=context_manager,
            rag_engine=rag_engine,
            context_builder=context_builder,
        )
        self._search_pipeline = (
            SearchPipelineNodes(llm_service=llm_service, tool_manager=tool_manager)
            if tool_manager
            else None
        )
        self._react_nodes = (
            ReActNodes(llm_service=llm_service, tool_manager=tool_manager) if tool_manager else None
        )
        self._em_nodes = (
            EMMemoryNodes(char_em_llm_integrator, prof_em_llm_integrator)
            if char_em_llm_integrator
            else None
        )
        self._thinking_node = ThinkingNode(llm_service=llm_service)

        # Dynamic agents (custom + default)
        self._custom_agent_registry = custom_agent_registry
        self._agent_configs = self._load_agent_configs()
        self._default_agent_id = self._resolve_default_agent_id(self._agent_configs)
        self._supervisor_node = SupervisorNode(
            self._agent_configs,
            self._default_agent_id,
            llm_service=llm_service,
        )
        self._custom_agent_nodes = self._build_custom_agent_nodes(
            self._agent_configs,
            prof_em_llm_integrator=prof_em_llm_integrator,
        )

        logger.info("TeporaGraph initialized")

        self._graph = self._build_graph()

    def _build_graph(self):
        """Build and compile the LangGraph workflow (V2 full pipeline)."""
        workflow = StateGraph(AgentState)

        # --- Nodes ---
        workflow.add_node(GraphNodes.EM_MEMORY_RETRIEVAL, self._em_memory_retrieval_wrapper)
        workflow.add_node(GraphNodes.THINKING_NODE, self._thinking_node_wrapper)
        workflow.add_node(GraphNodes.DIRECT_ANSWER, self._direct_answer_wrapper)
        workflow.add_node(GraphNodes.GENERATE_SEARCH_QUERY, self._generate_search_query_wrapper)
        workflow.add_node(GraphNodes.EXECUTE_SEARCH, self._execute_search_wrapper)
        workflow.add_node(GraphNodes.SUMMARIZE_SEARCH_RESULT, self._summarize_search_wrapper)
        workflow.add_node(GraphNodes.GENERATE_ORDER, self._generate_order_wrapper)
        workflow.add_node(GraphNodes.AGENT_REASONING, self._agent_reasoning_wrapper)
        workflow.add_node(GraphNodes.TOOL_NODE, self._tool_executor_wrapper)
        workflow.add_node(GraphNodes.UPDATE_SCRATCHPAD, self._update_scratchpad_wrapper)
        workflow.add_node(
            GraphNodes.SYNTHESIZE_FINAL_RESPONSE, self._synthesize_final_response_wrapper
        )
        workflow.add_node(GraphNodes.SUPERVISOR, self._supervisor_wrapper)

        for agent_id, agent_node in self._custom_agent_nodes.items():
            workflow.add_node(self._agent_node_name(agent_id), agent_node.execute)
        workflow.add_node(GraphNodes.EM_MEMORY_FORMATION, self._em_memory_formation_wrapper)
        workflow.add_node(GraphNodes.EM_STATS, self._em_stats_wrapper)

        # --- Edges ---
        workflow.set_entry_point(GraphNodes.EM_MEMORY_RETRIEVAL)

        workflow.add_conditional_edges(
            GraphNodes.EM_MEMORY_RETRIEVAL,
            route_by_command,
            {
                GraphRoutes.AGENT_MODE: GraphNodes.SUPERVISOR,
                GraphRoutes.SEARCH: GraphNodes.GENERATE_SEARCH_QUERY,
                GraphRoutes.DIRECT_ANSWER: GraphNodes.THINKING_NODE,
                GraphRoutes.STATS: GraphNodes.EM_STATS,
            },
        )

        # Direct
        workflow.add_edge(GraphNodes.THINKING_NODE, GraphNodes.DIRECT_ANSWER)
        workflow.add_edge(GraphNodes.DIRECT_ANSWER, GraphNodes.EM_MEMORY_FORMATION)

        # Search
        workflow.add_edge(GraphNodes.GENERATE_SEARCH_QUERY, GraphNodes.EXECUTE_SEARCH)
        workflow.add_edge(GraphNodes.EXECUTE_SEARCH, GraphNodes.SUMMARIZE_SEARCH_RESULT)
        workflow.add_edge(GraphNodes.SUMMARIZE_SEARCH_RESULT, GraphNodes.EM_MEMORY_FORMATION)

        # Agent (Hierarchical)
        route_map = {"planner": GraphNodes.GENERATE_ORDER}
        for agent_id in self._custom_agent_nodes:
            route_map[agent_id] = self._agent_node_name(agent_id)

        workflow.add_conditional_edges(
            GraphNodes.SUPERVISOR,
            route_from_supervisor,
            route_map,
        )

        workflow.add_edge(GraphNodes.GENERATE_ORDER, GraphNodes.SUPERVISOR)

        for agent_id in self._custom_agent_nodes:
            workflow.add_edge(
                self._agent_node_name(agent_id),
                GraphNodes.SYNTHESIZE_FINAL_RESPONSE,
            )

        workflow.add_edge(GraphNodes.SYNTHESIZE_FINAL_RESPONSE, GraphNodes.EM_MEMORY_FORMATION)

        # End
        workflow.add_edge(GraphNodes.EM_MEMORY_FORMATION, GraphNodes.EM_STATS)
        workflow.add_edge(GraphNodes.EM_STATS, END)

        logger.info("Graph construction complete")
        return workflow.compile()

    def _agent_node_name(self, agent_id: str) -> str:
        return f"agent_{agent_id}"

    def _resolve_default_agent_id(self, agents: list[CustomAgentConfig]) -> str:
        for agent in agents:
            if agent.id.startswith("__default_"):
                return agent.id
        return agents[0].id if agents else "__default_professional__"

    def _load_agent_configs(self) -> list[CustomAgentConfig]:
        agents = self._custom_agent_registry.list_agents(enabled_only=True)

        default_id = "__default_professional__"
        if not any(agent.id == default_id for agent in agents):
            agents.append(
                CustomAgentConfig(
                    id=default_id,
                    name="Professional Agent",
                    description="Default professional agent",
                    icon="A",
                    system_prompt="You are a professional agent.",
                    tool_policy=CustomAgentToolPolicy(),
                    enabled=True,
                )
            )
        return agents

    def _build_custom_agent_nodes(
        self,
        agents: list[CustomAgentConfig],
        *,
        prof_em_llm_integrator: Any | None = None,
    ) -> dict[str, Any]:
        nodes: dict[str, Any] = {}

        if not self.tool_manager:
            # Fallback stubs when tools are unavailable
            class _UnavailableAgent:
                async def execute(
                    self, _state: AgentState, _config: RunnableConfig | None = None
                ) -> dict[str, Any]:
                    return {"agent_outcome": "Agent tools are not available."}

            for agent in agents:
                nodes[agent.id] = _UnavailableAgent()  # type: ignore[assignment]
            return nodes

        for agent in agents:
            nodes[agent.id] = CustomAgentNode(
                llm_service=self.llm_service,
                tool_manager=self.tool_manager,
                agent_config=agent,
                registry=self._custom_agent_registry,
                prof_em_llm_integrator=prof_em_llm_integrator,
            )
        return nodes

    # --- Wrappers (inject prompts/dependencies) ---

    async def _direct_answer_wrapper(self, state: AgentState) -> dict[str, Any]:
        persona, _ = config.get_persona_prompt_for_profile()
        system_prompt = config.get_prompt_for_profile(
            "direct_answer",
            base=config.resolve_system_prompt("direct_answer"),
        )
        return await self._chat_node.direct_answer_node(
            state,
            persona=persona or "",
            system_prompt=system_prompt,
        )

    async def _thinking_node_wrapper(self, state: AgentState) -> dict[str, Any]:
        return await self._thinking_node.thinking_node(state)

    async def _generate_search_query_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._search_pipeline:
            logger.warning("SearchPipelineNodes not available (tool_manager missing).")
            return {"search_queries": []}
        return await self._search_pipeline.generate_search_query_node(state)

    async def _execute_search_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._search_pipeline:
            logger.warning("SearchPipelineNodes not available (tool_manager missing).")
            return {"search_results": []}
        return await self._search_pipeline.execute_search_node(state)

    async def _summarize_search_wrapper(self, state: AgentState) -> dict[str, Any]:
        persona, _ = config.get_persona_prompt_for_profile()
        system_template = config.get_prompt_for_profile(
            "search_summary",
            base=config.resolve_system_prompt("search_summary"),
        )

        tool_executor = self.tool_manager.aexecute_tool if self.tool_manager else None
        return await self._search_node.summarize_search_result_node(
            state,
            persona=persona or "",
            system_template=system_template,
            tool_executor=tool_executor,
        )

    async def _generate_order_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._react_nodes:
            logger.warning("ReActNodes not available (tool_manager missing).")
            return {"order": {}, "task_input": None}
        result = await self._react_nodes.generate_order_node(state)
        shared_context = state.get("shared_context") or {}
        shared_context["current_plan"] = result.get("order")
        return {**result, "shared_context": shared_context}

    async def _agent_reasoning_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._react_nodes:
            logger.warning("ReActNodes not available (tool_manager missing).")
            return {"agent_outcome": "agent_not_available"}
        return await self._react_nodes.agent_reasoning_node(state)

    async def _tool_executor_wrapper(
        self, state: AgentState, config: RunnableConfig
    ) -> dict[str, Any]:
        if not self._react_nodes:
            logger.warning("ReActNodes not available (tool_manager missing).")
            return {}
        return await self._react_nodes.unified_tool_executor_node(state, config)

    async def _supervisor_wrapper(self, state: AgentState) -> dict[str, Any]:
        return await self._supervisor_node.supervise(state)

    def _update_scratchpad_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._react_nodes:
            return {}
        return self._react_nodes.update_scratchpad_node(state)

    async def _synthesize_final_response_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._react_nodes:
            logger.warning("ReActNodes not available (tool_manager missing).")
            return {"messages": []}
        return await self._react_nodes.synthesize_final_response_node(state)

    def _em_memory_retrieval_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._em_nodes:
            return {"recalled_episodes": [], "synthesized_memory": "No memory system available."}
        return self._em_nodes.em_memory_retrieval_node(state)

    async def _em_memory_formation_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._em_nodes:
            return {}
        return await self._em_nodes.em_memory_formation_node(state)

    def _em_stats_wrapper(self, state: AgentState) -> dict[str, Any]:
        if not self._em_nodes:
            return {}
        return self._em_nodes.em_stats_node(state)

    async def process(
        self,
        session_id: str,
        message: str,
        *,
        mode: str = "chat",
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
        initial_state = create_initial_state(
            session_id=session_id,
            user_input=message,
            mode=mode,
            chat_history=chat_history,
        )
        from typing import cast

        for key, value in kwargs.items():
            if key in initial_state:
                cast(dict, initial_state)[key] = value

        run_config: RunnableConfig = cast(
            RunnableConfig, {"recursion_limit": config.GRAPH_RECURSION_LIMIT, "configurable": {}}
        )
        async for event in self.astream_events(initial_state, run_config=run_config):
            if event.get("event") != config.STREAM_EVENT_CHAT_MODEL:
                continue
            chunk = (event.get("data") or {}).get("chunk")
            if chunk is not None and getattr(chunk, "content", None):
                yield str(chunk.content)

    async def astream_events(
        self, initial_state: AgentState, *, run_config: RunnableConfig | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream LangGraph events (V1-compatible event dicts)."""
        from typing import cast

        cfg: RunnableConfig = cast(
            RunnableConfig,
            run_config or {"recursion_limit": config.GRAPH_RECURSION_LIMIT, "configurable": {}},
        )
        assert self._graph is not None
        async for event in self._graph.astream_events(initial_state, version="v2", config=cfg):
            yield event

    async def invoke(
        self,
        session_id: str,
        message: str,
        *,
        mode: str = "chat",
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
        initial_state = create_initial_state(
            session_id=session_id,
            user_input=message,
            mode=mode,
            chat_history=chat_history,
        )

        from typing import cast

        for key, value in kwargs.items():
            if key in initial_state:
                cast(dict, initial_state)[key] = value

        run_config: RunnableConfig = cast(
            RunnableConfig, {"recursion_limit": config.GRAPH_RECURSION_LIMIT, "configurable": {}}
        )
        result = await self._graph.ainvoke(initial_state, config=run_config)
        return cast(dict[str, Any], result)

    def cleanup(self) -> None:
        """Cleanup graph resources."""
        logger.info("TeporaGraph cleanup complete")
