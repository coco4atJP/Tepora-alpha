

import pytest

from src.core.config.schema import CustomAgentConfig
from src.core.graph.nodes.supervisor import SupervisorNode
from src.core.graph.state import AgentState


@pytest.mark.asyncio
async def test_supervisor_direct_routing():
    """
    Test that SupervisorNode routes to the specific agent when agent_mode is 'direct'.
    """
    # Setup agents
    agent1 = CustomAgentConfig(id="agent_1", name="Agent 1", system_prompt="Prompt 1", enabled=True)
    agent2 = CustomAgentConfig(id="agent_2", name="Agent 2", system_prompt="Prompt 2", enabled=True)
    agents = [agent1, agent2]

    supervisor = SupervisorNode(agents, default_agent_id="agent_1")

    # Helper to create full state
    def create_state(**kwargs) -> AgentState:
        defaults: AgentState = {
            "session_id": "test_session",
            "input": "",
            "mode": "agent",
            "chat_history": [],
            "agent_id": None,
            "agent_mode": None,
            "selected_agent_id": None,
            "supervisor_route": None,
            "shared_context": {},
            "agent_scratchpad": [],
            "messages": [],
            "agent_outcome": None,
            "recalled_episodes": None,
            "synthesized_memory": None,
            "search_queries": None,
            "search_results": None,
            "search_attachments": None,
            "skip_web_search": False,
            "generation_logprobs": None
        }
        defaults.update(kwargs)  # type: ignore
        return defaults

    # Case 1: agent_mode="direct" with valid agent_id
    state_valid = create_state(
        input="do something",
        agent_mode="direct",
        agent_id="agent_2"
    )

    result = await supervisor.supervise(state_valid)

    assert result["supervisor_route"] == "agent_2"
    assert result["selected_agent_id"] == "agent_2"

    # Case 2: agent_mode="direct" with invalid agent_id (fallback to default or name match)
    state_invalid = create_state(
        input="do something agent 1",
        agent_mode="direct",
        agent_id="non_existent_agent"
    )

    # Note: Logic falls back to name matching or default if ID not found in known set
    result_invalid = await supervisor.supervise(state_invalid)

    # Should fall back to routing logic (select_agent)
    # Since input contains "agent 1", it might select agent_1
    assert result_invalid["supervisor_route"] == "agent_1"

    # Case 3: agent_mode="high" (Planner) - Priority over direct?
    # Actually Supervisor code checks agent_mode="high" BEFORE direct.
    state_high = create_state(
        input="do something",
        agent_mode="high",
        agent_id="agent_2"
    )

    result_high = await supervisor.supervise(state_high)
    assert result_high["supervisor_route"] == "planner"
