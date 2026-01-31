"""
Custom Agent Node

Executes a custom agent using a ReAct-style loop with per-agent tool policies
and memory isolation (no direct chat_history exposure).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from langchain_core.runnables import RunnableConfig

from ... import config
from ...agent.registry import CustomAgentRegistry
from ...models.config import ModelConfigResolver
from .react import ReActNodes

if TYPE_CHECKING:
    from langchain_core.tools import BaseTool

    from ...config.schema import CustomAgentConfig
    from ...em_llm import EMLLMIntegrator
    from ...llm import LLMService
    from ...tools import ToolManager
    from ..state import AgentState

logger = logging.getLogger(__name__)


class CustomAgentNode:
    """Runs a single custom agent with its tool policy and prompt."""

    def __init__(
        self,
        *,
        llm_service: LLMService,
        tool_manager: ToolManager,
        agent_config: CustomAgentConfig,
        registry: CustomAgentRegistry,
        prof_em_llm_integrator: EMLLMIntegrator | None = None,
        max_steps: int | None = None,
    ) -> None:
        self._llm_service = llm_service
        self._tool_manager = tool_manager
        self._agent = agent_config
        self._registry = registry
        self._prof_em_llm = prof_em_llm_integrator
        self._react_nodes = ReActNodes(llm_service=llm_service, tool_manager=tool_manager)
        self._max_steps = max_steps or min(config.GRAPH_RECURSION_LIMIT, 8)

    def _format_prof_memory(self, memories: list[dict]) -> str:
        if not memories:
            return "No relevant professional memories found."
        return "\n\n".join(
            [
                f"Memory {i + 1}: {m.get('summary') or m.get('content', '')}".strip()
                for i, m in enumerate(memories)
            ]
        )

    def _build_system_prompt(self, tools: list[BaseTool]) -> str:
        _ = tools  # Tool list is injected by ReActNodes via {tools} placeholder.
        base = config.BASE_SYSTEM_PROMPTS["react_professional"]
        skills_prompt = self._registry.get_skills_as_prompt(self._agent.id)
        system_blocks = [self._agent.system_prompt, skills_prompt, base]
        return "\n\n".join(block for block in system_blocks if block)

    def _filter_tools(self, tools: list[BaseTool]) -> list[BaseTool]:
        tool_filter = self._registry.get_tool_filter(self._agent.id)
        return list(tool_filter(tools))

    def _resolve_model_id(self) -> str | None:
        if not self._agent.model_config_name:
            return None

        model_manager = getattr(self._llm_service, "_model_manager", None)
        if not model_manager:
            return None

        direct_match = model_manager.get_model(self._agent.model_config_name)
        if direct_match:
            return str(direct_match.id)

        resolver = ModelConfigResolver(model_manager)
        model_path = resolver.resolve_model_path(self._agent.model_config_name)
        if not model_path:
            return None

        try:
            target = Path(model_path).resolve()
        except Exception:
            return None

        for model in model_manager.get_available_models():
            try:
                if Path(model.path).resolve() == target:
                    return str(model.id)
            except Exception:
                continue

        return None

    async def execute(
        self, state: AgentState, config: RunnableConfig | None = None
    ) -> dict[str, Any]:
        logger.info("CustomAgentNode '%s' executing", self._agent.id)

        # Start from a clean agent loop state
        agent_state: dict[str, Any] = dict(state)
        agent_state["agent_scratchpad"] = []
        agent_state["messages"] = []
        agent_state["agent_outcome"] = None
        agent_state["task_result"] = None

        shared_context = agent_state.get("shared_context") or {}
        agent_state["shared_context"] = shared_context

        # Tool policy
        filtered_tools = self._filter_tools(self._tool_manager.all_tools)
        allowed_tool_names = {t.name for t in filtered_tools}

        # Professional memory (shared guidance)
        prof_memory_str = "No relevant professional memories found."
        if self._prof_em_llm:
            try:
                memories = self._prof_em_llm.retrieve_relevant_memories_for_query(
                    state.get("input", "")
                )
                prof_memory_str = self._format_prof_memory(memories)
                shared_context["professional_memory"] = prof_memory_str
            except Exception as exc:
                logger.warning("Failed to retrieve professional memory: %s", exc, exc_info=True)

        system_prompt = self._build_system_prompt(filtered_tools)
        model_id = self._resolve_model_id()

        for step in range(self._max_steps):
            logger.debug("Custom agent '%s' step %d", self._agent.id, step + 1)
            reasoning_result = await self._react_nodes.agent_reasoning_node(
                cast("AgentState", agent_state),
                tools=filtered_tools,
                system_prompt=system_prompt,
                long_term_memory=prof_memory_str,
                model_id=model_id,
                run_config=config,
            )

            agent_state.update(reasoning_result)

            if agent_state.get("agent_outcome"):
                break

            # Execute tool calls if present
            if agent_state.get("messages"):
                tool_result = await self._react_nodes.unified_tool_executor_node(
                    cast("AgentState", agent_state),
                    config,
                    allowed_tools=allowed_tool_names,
                    require_confirmation_fn=lambda tool_name: self._registry.requires_confirmation(
                        self._agent.id, tool_name
                    ),
                )
                agent_state.update(tool_result)

                scratchpad_update = self._react_nodes.update_scratchpad_node(
                    cast("AgentState", agent_state)
                )
                agent_state.update(scratchpad_update)
            else:
                break

        if not agent_state.get("agent_outcome"):
            # Fallback if the loop did not terminate cleanly
            messages = agent_state.get("messages") or []
            fallback_text = None
            if messages:
                last_msg = messages[-1]
                if hasattr(last_msg, "content"):
                    fallback_text = str(last_msg.content)
            agent_state["agent_outcome"] = fallback_text or "Agent did not produce a final answer."

        # Preserve shared context updates
        agent_state["shared_context"] = shared_context

        return {
            "agent_scratchpad": agent_state.get("agent_scratchpad"),
            "messages": agent_state.get("messages"),
            "agent_outcome": agent_state.get("agent_outcome"),
            "task_result": agent_state.get("task_result"),
            "shared_context": agent_state.get("shared_context"),
        }
