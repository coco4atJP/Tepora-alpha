"""
LangGraph で用いるエージェント状態の型定義をまとめたモジュール。

フィールド概要:
- `input`: 現在のユーザー入力
- `chat_history`: これまでのユーザー/AIメッセージ履歴
- `agent_scratchpad`: ReActループ専用のワークスペース(思考/ツール呼び出し/結果)
- `messages`: ノード間受け渡し専用のメッセージ(特にToolNodeで使用)
- `agent_outcome`: Agentモードの最終成果物(内部レポート等)
- `search_queries`/`search_results`: 検索系ルートで使用
"""

# agent_core/state.py

from typing import TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage


class AgentAction(TypedDict):
    tool: str
    tool_input: dict


class AgentFinish(TypedDict):
    return_values: dict
    log: str


class AgentState(TypedDict):
    # 初期入力と全体のチャット履歴
    input: str
    # Routing Mode (direct, search, agent, etc.)
    mode: str | None
    chat_history: list[HumanMessage | AIMessage]

    # AgentModeのReActループ専用の履歴 (思考、ツール呼び出し、ツール結果)
    agent_scratchpad: list[BaseMessage]

    # LangGraphのノード間通信用のメッセージリスト
    # ToolNodeが処理対象とするため、Noneではなく空配列で初期化する想定
    messages: list[BaseMessage]

    # AgentModeの最終的な成果物
    agent_outcome: str | None

    # --- EM-LLM Memory Pipeline ---
    # 1. 検索された生のエピソード
    recalled_episodes: list[dict] | None
    # 2. SLMによって統合された記憶
    synthesized_memory: str | None

    # ストリーミング生成時に収集されたlogprobs
    generation_logprobs: dict | list[dict] | None

    # 検索用
    search_queries: list[str] | None
    search_results: list[dict] | None
    search_query: str | None
    search_attachments: list[dict] | None

    # キャラクターが生成した、プロフェッショナル向けの指示書
    order: dict | None

    # --- A2A Protocol ---
    # A2Aメッセージ (dict形式)
    task_input: dict | None  # MessageType.TASK
    task_result: dict | None  # MessageType.RESULT
