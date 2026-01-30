"""
Supervisor Node

Routes agent-mode requests to planner or specialized agents.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from langchain_core.prompts import ChatPromptTemplate

if TYPE_CHECKING:
    from ...config.schema import CustomAgentConfig
    from ..state import AgentState

logger = logging.getLogger(__name__)


class SupervisorNode:
    """Lightweight supervisor router with heuristic routing."""

    def __init__(
        self,
        agents: list[CustomAgentConfig],
        default_agent_id: str,
        *,
        llm_service=None,
    ):
        self._agents = agents
        self._default_agent_id = default_agent_id
        self._llm_service = llm_service

    def _should_use_planner(self, user_input: str) -> bool:
        text = user_input.lower()
        if len(text.split()) >= 18:
            return True

        complexity_markers = [
            "research",
            "compare",
            "analyze",
            "analysis",
            "plan",
            "steps",
            "strategy",
            "summarize",
            "investigate",
            "benchmark",
            "design",
        ]
        return any(marker in text for marker in complexity_markers)

    def _select_agent(self, user_input: str) -> str:
        if not self._agents:
            return self._default_agent_id

        # If only one agent, use it
        if len(self._agents) == 1:
            return self._agents[0].id

        lowered = user_input.lower()
        for agent in self._agents:
            if agent.id.lower() in lowered or agent.name.lower() in lowered:
                return agent.id
            if agent.description and agent.description.lower() in lowered:
                return agent.id

        return self._default_agent_id

    async def _decide_fast_route(self, user_input: str) -> str:
        """
        Use a model to decide whether to plan or route directly.

        Returns:
            "planner" or "direct"
        """
        if not self._llm_service:
            return "planner" if self._should_use_planner(user_input) else "direct"

        try:
            llm = await self._llm_service.get_client("character")
            prompt = ChatPromptTemplate.from_messages(
                [
                    (
                        "system",
                        "You are a routing agent. Decide if the request needs planning. "
                        "Respond ONLY with <route>planner</route> or <route>direct</route>.",
                    ),
                    ("human", "{input}"),
                ]
            )
            chain = prompt | llm
            response = await chain.ainvoke({"input": user_input})
            raw = response.content if isinstance(response.content, str) else str(response.content)
            match = re.search(r"<route>\s*(planner|direct)\s*</route>", raw, re.IGNORECASE)
            if match:
                return match.group(1).lower()
            lowered = raw.lower()
            if "planner" in lowered:
                return "planner"
            if "direct" in lowered:
                return "direct"
        except Exception as exc:
            logger.warning("Supervisor fast routing failed: %s", exc, exc_info=True)

        return "planner" if self._should_use_planner(user_input) else "direct"

    async def supervise(self, state: AgentState) -> dict:
        shared_context = state.get("shared_context") or {}
        user_input = state.get("input", "")
        agent_mode = state.get("agent_mode") or "fast"

        direct_agent_id = state.get("agent_id")
        known_ids = {agent.id for agent in self._agents}
        direct_agent_valid = None
        if direct_agent_id:
            if direct_agent_id in known_ids:
                direct_agent_valid = direct_agent_id
            else:
                logger.warning(
                    "Supervisor: requested agent '%s' not found; falling back to routing",
                    direct_agent_id,
                )

        if shared_context.get("current_plan"):
            selected = direct_agent_valid or self._select_agent(user_input)
            logger.info("Supervisor: routing to agent '%s' after planning", selected)
            return {
                "supervisor_route": selected,
                "selected_agent_id": selected,
                "shared_context": shared_context,
            }

        if agent_mode == "high":
            logger.info("Supervisor: forced planning (high mode)")
            return {
                "supervisor_route": "planner",
                "shared_context": shared_context,
            }

        if agent_mode == "direct":
            selected = direct_agent_valid or self._select_agent(user_input)
            logger.info("Supervisor: direct mode, routing to agent '%s'", selected)
            return {
                "supervisor_route": selected,
                "selected_agent_id": selected,
                "shared_context": shared_context,
            }

        # Fast mode: model decides whether to plan
        if agent_mode == "fast":
            decision = await self._decide_fast_route(user_input)
            if decision == "planner":
                logger.info("Supervisor: fast mode decided planning")
                return {
                    "supervisor_route": "planner",
                    "shared_context": shared_context,
                }
            selected = direct_agent_valid or self._select_agent(user_input)
            logger.info("Supervisor: fast mode decided direct agent '%s'", selected)
            return {
                "supervisor_route": selected,
                "selected_agent_id": selected,
                "shared_context": shared_context,
            }

        if self._should_use_planner(user_input):
            logger.info("Supervisor: routing to planner")
            return {
                "supervisor_route": "planner",
                "shared_context": shared_context,
            }

        selected = direct_agent_valid or self._select_agent(user_input)
        logger.info("Supervisor: routing directly to agent '%s'", selected)
        return {
            "supervisor_route": selected,
            "selected_agent_id": selected,
            "shared_context": shared_context,
        }
