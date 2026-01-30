"""
Graph State Definitions for V2

AgentState with session_id for V2 architecture.
Maintains all fields from V1 for compatibility.
"""

from typing import TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage


class AgentAction(TypedDict):
    """Action to be taken by agent."""

    tool: str
    tool_input: dict


class AgentFinish(TypedDict):
    """Agent finished result."""

    return_values: dict
    log: str


class AgentState(TypedDict):
    """
    LangGraph state for agent execution.

    V2 additions:
    - session_id: Session identifier for session-scoped operations

    Maintains all V1 fields for compatibility.
    """

    # V2: Session identifier
    session_id: str

    # Core input and history
    input: str
    mode: str | None
    chat_history: list[HumanMessage | AIMessage]

    # Hierarchical agent routing
    agent_id: str | None  # Direct agent selection from user/UI
    agent_mode: str | None  # "high" | "fast" | "direct"
    selected_agent_id: str | None  # Agent chosen by supervisor
    supervisor_route: str | None  # "planner" | agent_id
    shared_context: dict | None  # Shared workspace across agents

    # Agent ReAct loop state
    agent_scratchpad: list[BaseMessage]
    messages: list[BaseMessage]
    agent_outcome: str | None

    # EM-LLM Memory Pipeline
    recalled_episodes: list[dict] | None
    synthesized_memory: str | None

    # Generation metadata
    generation_logprobs: dict | list[dict] | None

    # Search mode state
    search_queries: list[str] | None
    search_results: list[dict] | None
    search_query: str | None
    search_attachments: list[dict] | None

    # Skip web search flag
    skip_web_search: bool | None

    # Agent order (character -> professional)
    order: dict | None

    # A2A Protocol
    task_input: dict | None
    task_result: dict | None

    # Thinking Mode (CoT)
    thinking_mode: bool | None
    thought_process: str | None


def create_initial_state(
    session_id: str,
    user_input: str,
    mode: str = "direct",
    chat_history: list | None = None,
) -> AgentState:
    """
    Create initial agent state for a new request.

    Args:
        session_id: Session identifier
        user_input: User's input message
        mode: Processing mode (direct, search, agent)
        chat_history: Existing chat history

    Returns:
        Initialized AgentState
    """
    return AgentState(
        session_id=session_id,
        input=user_input,
        mode=mode,
        chat_history=chat_history or [],
        agent_id=None,
        agent_mode=None,
        selected_agent_id=None,
        supervisor_route=None,
        shared_context={
            "current_plan": None,
            "artifacts": [],
            "notes": [],
        },
        agent_scratchpad=[],
        messages=[],
        agent_outcome=None,
        recalled_episodes=None,
        synthesized_memory=None,
        generation_logprobs=None,
        search_queries=None,
        search_results=None,
        search_query=None,
        search_attachments=None,
        skip_web_search=None,
        order=None,
        task_input=None,
        task_result=None,
        thinking_mode=None,
        thought_process=None,
    )
