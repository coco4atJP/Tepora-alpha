"""
エージェントの実行グラフをLangGraphで構築するモジュール。

要素:
- ルーティング関数: ユーザー入力のコマンドでモードを切替
- 各種ノード: ダイレクト応答、検索系、ReActループ、最終応答生成
- Unified Tool Executor: ToolManagerにツール実行を委任

設計ポイント:
- ReActループでは `agent_scratchpad` をLLMに渡せる文字列に整形
- LLMの出力は厳密なJSONを期待し、失敗時は自己修正を促す
"""

# agent_core/graph.py

import json
import asyncio
import re 
from typing import Literal, List, Dict, Optional

from langchain_core.messages import AIMessage, ToolMessage, BaseMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import BaseTool
from langgraph.graph import StateGraph, END

from .state import AgentState
from .tool_manager import ToolManager
from .llm_manager import LLMManager # MemoryProcessorは不要になった
from .memory.memory_system import MemorySystem
from . import config

# --- Helper Function ---

def _format_scratchpad(scratchpad: List[BaseMessage]) -> str:
    """agent_scratchpadの内容をLLMが理解しやすい文字列にフォーマットする"""
    print(f"Formatting scratchpad with {len(scratchpad)} messages")
    
    if not scratchpad:
        print("Scratchpad is empty")
        return ""
    
    string_messages = []
    for i, message in enumerate(scratchpad):
        print(f"  Message {i+1}: {type(message).__name__}")
        if isinstance(message, AIMessage):
            if message.tool_calls:
                # 思考とツール呼び出しを分ける
                thought = message.content
                tool_call = message.tool_calls[0]
                tool_name = tool_call['name']
                tool_args = tool_call['args']
                
                # 辞書オブジェクトを作成し、json.dumpsで一度にシリアライズする
                action_obj = {
                    "thought": thought,
                    "action": {
                        "tool_name": tool_name,
                        "args": tool_args
                    }
                }
                formatted_msg = json.dumps(action_obj, ensure_ascii=False)
                string_messages.append(formatted_msg)
                print(f"    AI Message with tool call: {tool_name}")
            else:
                # ツール呼び出しのないAIメッセージ (エラーなど)
                string_messages.append(message.content)
                print(f"    AI Message without tool call: {message.content[:50]}...")

        elif isinstance(message, ToolMessage):
            # ツール実行結果
            observation_obj = {"observation": message.content}
            formatted_msg = json.dumps(observation_obj, ensure_ascii=False)
            string_messages.append(formatted_msg)
            print(f"    Tool Message: {message.content[:50]}...")
    
    # 各ステップを改行で区切る
    result = "\n".join(string_messages)
    print(f"Formatted scratchpad length: {len(result)} characters")
    return result

class _GraphNodes:
    """LangGraphのノード名を定義する定数クラス"""
    MEMORY_RETRIEVAL = "memory_retrieval"
    DIRECT_ANSWER = "direct_answer"
    GENERATE_SEARCH_QUERY = "generate_search_query"
    EXECUTE_SEARCH = "execute_search"
    SUMMARIZE_SEARCH_RESULT = "summarize_search_result"
    GENERATE_ORDER = "generate_order_node"
    AGENT_REASONING = "agent_reasoning_node"
    SYNTHESIZE_FINAL_RESPONSE = "synthesize_final_response_node"
    TOOL_NODE = "tool_node"
    UPDATE_SCRATCHPAD = "update_scratchpad_node"
    SAVE_MEMORY = "save_memory_node"


class AgentCore:
    """アプリ全体の実行グラフを組み立て、実行するためのファサード。"""
    def __init__(self, llm_manager: LLMManager, tool_manager: ToolManager, memory_system: Optional[MemorySystem] = None):
        self.llm_manager = llm_manager
        self.tool_manager = tool_manager
        self.memory_system = memory_system
        self.graph = self._build_graph()

    def memory_retrieval_node(self, state: AgentState) -> dict:
        """入力に基づいて関連するエピソード記憶を検索する。"""
        print("--- Node: Memory Retrieval ---")
        if not self.memory_system:
            print("Warning: Memory system not available. Skipping retrieval.")
            return {"recalled_episodes": [], "synthesized_memory": "No memory system available."}
        try:
            recalled_episodes = self.memory_system.retrieve_similar_episodes(state["input"])
            if recalled_episodes:
                print(f"Retrieved {len(recalled_episodes)} relevant episodes.")
                # 後続ノードが直接利用できるように、エピソードリストを文字列にフォーマットする
                formatted_memory = "\n\n".join([
                    f"Recalled Episode {i+1}:\n- Summary: {ep.get('summary', 'N/A')}"
                    for i, ep in enumerate(recalled_episodes)
                ])
                return {"recalled_episodes": recalled_episodes, "synthesized_memory": formatted_memory}
            else:
                print("No relevant memories found.")
                return {"recalled_episodes": [], "synthesized_memory": "No relevant memories found."}
        except Exception as e:
            print(f"Warning: Failed to retrieve memories: {e}")
            return {"recalled_episodes": [], "synthesized_memory": "An error occurred during memory retrieval."}

    def route_by_command(self, state: AgentState) -> Literal["agent_mode", "search", "direct_answer"]:
        """ユーザーの入力コマンドに基づいてルートを判断する"""
        user_input = state["input"].strip().lower()
        print(f"\n--- Routing Decision ---")
        print(f"User input: '{user_input}'")
        
        if user_input.startswith('/agentmode'):
            print("Route: agent_mode (ReAct loop)")
            return "agent_mode"
        elif user_input.startswith('/search'):
            print("Route: search")
            return "search"
        else:
            print("Route: direct_answer")
            return "direct_answer"

    def unified_tool_executor_node(self, state: AgentState) -> dict:
        """
        ToolManagerにツール実行を委任するだけのシンプルなノード。
        """
        print("--- Node: Unified Tool Executor ---")
        last_message = state.get("messages", [])[-1]
        if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
            print("No tool calls found in last message")
            return {}

        tool_calls = last_message.tool_calls
        print(f"Executing {len(tool_calls)} tool call(s)")
        tool_messages = []

        for i, tool_call in enumerate(tool_calls):
            tool_name = tool_call["name"]
            tool_args = tool_call["args"]
            tool_call_id = tool_call["id"]
            
            print(f"\n--- Tool Execution {i+1}/{len(tool_calls)} ---")
            print(f"Tool: {tool_name}")
            print(f"Arguments: {json.dumps(tool_args, indent=2, ensure_ascii=False)}")
            print(f"Call ID: {tool_call_id}")
            
            # ▼▼▼ ToolManagerに実行を委任 ▼▼▼
            print(f"Executing tool...")
            result_content = self.tool_manager.execute_tool(tool_name, tool_args)
            print(f"Tool result: {str(result_content)[:200]}...")
            
            tool_messages.append(
                ToolMessage(content=str(result_content), tool_call_id=tool_call_id)
            )
        
        print(f"\n--- Tool Execution Complete ---")
        print(f"Generated {len(tool_messages)} tool result message(s)")
        
        return {"messages": tool_messages}

    def _build_graph(self):
        """LangGraph のノード/エッジを定義し、コンパイルして返す。"""
        workflow = StateGraph(AgentState)

        # EM-LLM パイプラインノード
        workflow.add_node(_GraphNodes.MEMORY_RETRIEVAL, self.memory_retrieval_node)

        # 各モードの実行ノード
        workflow.add_node(_GraphNodes.DIRECT_ANSWER, self.direct_answer_node)
        workflow.add_node(_GraphNodes.GENERATE_SEARCH_QUERY, self.generate_search_query_node)
        workflow.add_node(_GraphNodes.EXECUTE_SEARCH, self.execute_search_node)
        workflow.add_node(_GraphNodes.SUMMARIZE_SEARCH_RESULT, self.summarize_search_result_node)
        workflow.add_node(_GraphNodes.GENERATE_ORDER, self.generate_order_node)
        workflow.add_node(_GraphNodes.AGENT_REASONING, self.agent_reasoning_node)
        workflow.add_node(_GraphNodes.SYNTHESIZE_FINAL_RESPONSE, self.synthesize_final_response_node)
        workflow.add_node(_GraphNodes.TOOL_NODE, self.unified_tool_executor_node) 
        workflow.add_node(_GraphNodes.UPDATE_SCRATCHPAD, self.update_scratchpad_node)
        
        # 最終的な記憶保存ノード
        workflow.add_node(_GraphNodes.SAVE_MEMORY, self.save_memory_node)
        
        # --- グラフの接続 ---

        # 1. エントリーポイントは記憶の検索から
        workflow.set_entry_point(_GraphNodes.MEMORY_RETRIEVAL)

        # 2. 記憶検索後、コマンドでルーティング
        workflow.add_conditional_edges(
            _GraphNodes.MEMORY_RETRIEVAL,
            self.route_by_command,
            {
                "agent_mode": _GraphNodes.GENERATE_ORDER,
                "search": _GraphNodes.GENERATE_SEARCH_QUERY,
                "direct_answer": _GraphNodes.DIRECT_ANSWER,
            }
        )

        # 3. 各ブランチのフロー
        # Direct Answer Path
        workflow.add_edge(_GraphNodes.DIRECT_ANSWER, _GraphNodes.SAVE_MEMORY)

        # Search Path
        workflow.add_edge(_GraphNodes.GENERATE_SEARCH_QUERY, _GraphNodes.EXECUTE_SEARCH)
        workflow.add_edge(_GraphNodes.EXECUTE_SEARCH, _GraphNodes.SUMMARIZE_SEARCH_RESULT)
        workflow.add_edge(_GraphNodes.SUMMARIZE_SEARCH_RESULT, _GraphNodes.SAVE_MEMORY)

        # Agent (ReAct) Path
        workflow.add_edge(_GraphNodes.GENERATE_ORDER, _GraphNodes.AGENT_REASONING)
        workflow.add_conditional_edges(
            _GraphNodes.AGENT_REASONING,
            self.should_continue_react_loop,
            {
                "continue": _GraphNodes.TOOL_NODE, 
                "end": _GraphNodes.SYNTHESIZE_FINAL_RESPONSE 
            },
        )
        workflow.add_edge(_GraphNodes.TOOL_NODE, _GraphNodes.UPDATE_SCRATCHPAD)
        workflow.add_edge(_GraphNodes.UPDATE_SCRATCHPAD, _GraphNodes.AGENT_REASONING)
        workflow.add_edge(_GraphNodes.SYNTHESIZE_FINAL_RESPONSE, _GraphNodes.SAVE_MEMORY)

        # 4. 最終出口
        workflow.add_edge(_GraphNodes.SAVE_MEMORY, END)

        return workflow.compile()

    def save_memory_node(self, state: AgentState) -> dict:
        """
        対話の最終的な内容をメモリシステムに保存する。
        memory_systemがなければ何もしない。
        """
        print("--- Node: Save Memory ---")
        if not self.memory_system:
            print("Warning: Memory system not available. Skipping save.")
            return {}

        try:
            # 最後のAIの応答を要約として保存する
            last_ai_message = next((msg for msg in reversed(state.get("chat_history", [])) if isinstance(msg, AIMessage)), None)
            if last_ai_message:
                self.memory_system.save_episode(summary=last_ai_message.content, history_json=json.dumps([m.dict() for m in state.get("chat_history", [])]))
        except Exception as e:
            print(f"Warning: Failed to save memory: {e}")

        return {}
    
    # --- ReAct Loop Nodes ---

    def generate_order_node(self, state: AgentState) -> dict:
        """
        キャラクター・エージェント(Gemma)が、ユーザーの要求をプロフェッショナル向けの「オーダー」に変換する。
        """
        print("--- Node: Generate Order (using Gemma 3N) ---")
        llm = self.llm_manager.get_character_agent()
        
        # オーダー生成専用のプロンプトを使用
        prompt = ChatPromptTemplate.from_messages([
            ("system", config.BASE_SYSTEM_PROMPTS["order_generation"] + "\n\n--- Relevant Context from Past Conversations ---\n{synthesized_memory}"),
            ("human", "Based on the user's request and the provided context, generate a structured plan (Order).\n\n--- User Request ---\n{input}\n\n--- Available Tools ---\n{tools}\n\nPlease generate the JSON order now.")
        ])
        chain = prompt | llm

        response_message = chain.invoke({
            "input": state["input"],
            # EM-LLM: 統合された記憶をコンテキストとして渡す
            "synthesized_memory": state.get("synthesized_memory", "No relevant context."),
            "tools": config.format_tools_for_react_prompt(self.tool_manager.tools)
        })
        
        # LLMが生成したJSON文字列をパースしてstateに保存
        try:
            order_json = json.loads(response_message.content)
            return {"order": order_json}
        except json.JSONDecodeError:
            # パース失敗時は、単純なオーダーでフォールバック
            return {"order": {"task_summary": state["input"], "steps": ["Research the user's request using available tools.", "Synthesize the findings."]}}

    def agent_reasoning_node(self, state: AgentState) -> dict:
        """
        ReActループの中核となるノード。LLMに思考とツール使用を促し、次のアクションを決定する。
        
        処理の流れ:
        1. ReActループ開始時のscratchpad初期化
        2. 過去の思考・ツール実行履歴を文字列に整形
        3. REACT_SYSTEM_PROMPTでLLMに思考とツール使用を指示
        4. LLMの出力をJSONとして解析
        5. "action"の場合はツール呼び出しメッセージを作成
        6. "finish"の場合はループ終了として結果を返却
        7. エラー時は自己修正を促すメッセージをscratchpadに追加
        """
        print("--- Node: Agent Reasoning ---")
        print("Starting ReAct loop...")

        # jan-nanoをロード
        print("--- Node: Agent Reasoning (using Jan-nano) ---")
        llm = self.llm_manager.get_professional_agent()

        # 1. ReActループの開始時にscratchpadを初期化
        if not state["agent_scratchpad"]:
            print("Initializing agent_scratchpad for new ReAct loop")
            state["agent_scratchpad"] = []
        
        # 2. 過去の思考・ツール実行履歴を文字列に整形
        scratchpad_str = _format_scratchpad(state["agent_scratchpad"])
        print(f"Current scratchpad: {scratchpad_str}")
        
        # 3.  システムプロンプトに変数を渡せるように、テンプレートを直接渡す
        system_prompt_template = config.BASE_SYSTEM_PROMPTS["react_professional"]
        prompt = ChatPromptTemplate.from_messages([
            ("system", system_prompt_template),
            ("human", "A user has made the following request:\nUser Request: {user_input}\n\nBased on this, the following order has been generated for you to execute:\nOrder: {order}\n\nHere is the history of your work on this order:\n{agent_scratchpad}")
        ])
        chain = prompt | llm

        print(f"Available tools: {[tool.name for tool in self.tool_manager.tools]}")

        print("\n--- LLM Processing ---")
        print(f"User Input for ReAct: {state['input']}")
        print(f"Scratchpad: {scratchpad_str}")
        
        response_message = chain.invoke({
            #  これでシステムプロンプト内の {tools} が展開される
            "tools": config.format_tools_for_react_prompt(self.tool_manager.tools),
            "user_input": state["input"],
            "order": json.dumps(state.get("order", {})),
            "agent_scratchpad": _format_scratchpad(state["agent_scratchpad"])
        })
        
        print(f"\n--- LLM Raw Output ---")
        print(f"Response content: {response_message.content}")
        
        try:
            # 4. CoT + JSON形式の出力を解析
            content_str = response_message.content
            
            # 正規表現でJSONブロックを検索
            json_match = re.search(r"```json\n(.*?)\n```", content_str, re.DOTALL)
            
            if not json_match:
                raise ValueError("Invalid format: JSON block not found in the output.")

            # 思考テキストとJSON文字列を分離
            thought_text = content_str[:json_match.start()].strip()
            json_str = json_match.group(1).strip()
            
            print(f"\n--- Parsed CoT Output ---")
            print(f"Thought: {thought_text}")
            print(f"JSON String: {json_str}")

            parsed_json = json.loads(json_str)
            print(f"\n--- Parsed JSON ---")
            print(f"Parsed successfully: {json.dumps(parsed_json, indent=2, ensure_ascii=False)}")

            # 5. "action"の場合はツール呼び出しメッセージを作成
            if "action" in parsed_json:
                action = parsed_json["action"]
                
                # ★修正: AIMessageのcontentに思考テキストを入れる
                tool_call_message = AIMessage(
                    content=thought_text,
                    tool_calls=[{
                        "name": action["tool_name"], "args": action.get("args", {}), "id": f"tool_call_{len(state['agent_scratchpad'])}"
                    }]
                )
                
                print(f"\n--- Tool Call Message Created ---")
                print(f"Content (Thought): {tool_call_message.content}")
                print(f"Tool calls: {tool_call_message.tool_calls}")
                
                return {
                    "agent_scratchpad": state["agent_scratchpad"] + [tool_call_message],
                    "messages": [tool_call_message]
                }

            # 6. "finish"の場合はループ終了として結果を返却
            elif "finish" in parsed_json:
                answer = parsed_json["finish"]["answer"]
                print(f"\n--- Finish Action Detected ---")
                print(f"Thought: {thought_text}")
                print(f"Final answer: {answer}")
                
                # 最終レポートに思考を含めることで、後続の要約ノードがより多くの文脈を利用できる
                final_report = f"Thought Process:\n{thought_text}\n\nTechnical Report:\n{answer}"
                
                return {"agent_outcome": final_report, "messages": []}
            
            else:
                raise ValueError("Invalid JSON: missing 'action' or 'finish' key.")

        except (json.JSONDecodeError, ValueError) as e:
            # 7. エラー時は自己修正を促すメッセージをscratchpadに追加
            print(f"\n--- Error Parsing LLM Output ---")
            print(f"Error: {e}")
            print(f"Raw content that failed to parse: {response_message.content}")
            error_ai_message = AIMessage(content=f"My last attempt failed. The response was not in the correct 'Thought then JSON' format. Error: {e}. I must correct my output to be a plain text thought, followed by a valid JSON block in ```json code fences.")
            return {"agent_scratchpad": state["agent_scratchpad"] + [error_ai_message]}

    def update_scratchpad_node(self, state: AgentState) -> dict:
        """
        ToolNodeによってmessagesに追加された、全てのToolMessageをagent_scratchpadに転記する
        """
        print("--- Node: Update Scratchpad ---")
        
        # messagesの末尾から遡って、連続するToolMessageを全て収集
        tool_messages = []
        for msg in reversed(state.get("messages", [])):
            if isinstance(msg, ToolMessage):
                tool_messages.insert(0, msg)
            else:
                break # ToolMessage以外のものが見つかったら停止

        if not tool_messages:
            print("Warning: No ToolMessage found to update scratchpad.")
            return {}

        print(f"Found {len(tool_messages)} tool result(s) to add to scratchpad.")
        print(f"Current scratchpad length: {len(state['agent_scratchpad'])}")
        
        for i, msg in enumerate(tool_messages):
            print(f"  - Tool Result {i+1}: {msg.content[:100]}...")
            print(f"    Tool Call ID: {msg.tool_call_id}")

        new_scratchpad = state["agent_scratchpad"] + tool_messages
        print(f"New scratchpad length: {len(new_scratchpad)}")
        
        return {"agent_scratchpad": new_scratchpad}

    def should_continue_react_loop(self, state: AgentState) -> Literal["continue", "end"]:
        """ReActループを継続するか(ツール呼び出しがあるか)で分岐する。"""
        print("--- Decision: Should Continue ReAct Loop? ---")
        
        if "agent_outcome" in state and state["agent_outcome"]:
            print("Decision: End ReAct loop (finish action detected).")
            print(f"Final outcome: {state['agent_outcome']}")
            return "end"
        
        # scratchpadの最後のメッセージがツール呼び出しなら継続
        if state["agent_scratchpad"]:
            last_message = state["agent_scratchpad"][-1]
            print(f"Last message in scratchpad: {type(last_message).__name__}")
            
            if isinstance(last_message, AIMessage) and last_message.tool_calls:
                print("Decision: Continue ReAct loop (last message has tool calls).")
                print(f"Tool calls: {[tc['name'] for tc in last_message.tool_calls]}")
                return "continue"
            else:
                print("Decision: End ReAct loop (last message has no tool calls).")
                if isinstance(last_message, AIMessage):
                    print(f"Last message content: {last_message.content[:100]}...")
                return "end"
        else:
            print("Decision: End ReAct loop (empty scratchpad).")
            return "end"

    # --- Other Paths (no changes) ---

    async def direct_answer_node(self, state: AgentState) -> dict:
        """シンプルなシステムプロンプトで一往復の応答を生成する。"""
        print("--- Node: Direct Answer (Streaming, EM-LLM Context) ---")

        # Gemma-3Nをロード
        llm = self.llm_manager.get_character_agent()
        # ペルソナとシステムプロンプトを結合
        persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]
        system_prompt = config.BASE_SYSTEM_PROMPTS["direct_answer"]

        # --- 階層型コンテキスト構築 (EM-LLM & Attention Sink準拠) ---
        # 論文(2407.09450v2)で述べられている階層構造を実装します。
        # 1. Attention Sink: モデルの安定化のための固定プレフィックス。
        # 2. System/Persona: エージェントの役割定義。
        # 3. Retrieved Memory: EM-LLMによって検索された長期記憶。
        # 4. Local Context: 直近の対話履歴（短期記憶）。

        full_history = state.get("chat_history", [])
        
        # 1. Attention Sink (固定プレフィックス)
        # 論文のセマンティック初期化の概念を参考に、自然な文頭に近い固定テキストを使用。
        # これが真の「アテンションシンク」として機能し、対話履歴の長さに影響されず安定します。
        attention_sink_prefix = "This is a conversation between a user and an AI assistant."
        attention_sink_context = [HumanMessage(content=attention_sink_prefix)]

        # 2. System/Persona Context
        system_persona_context = [HumanMessage(content=f"<instructions>\nYour persona and instructions for this conversation are defined as follows:\n\n<persona_definition>\n{persona}\n</persona_definition>\n\n<system_prompt>\n{system_prompt}\n</system_prompt>\n</instructions>")]

        # 3. Retrieved Memory Context (長期記憶)
        retrieved_memory_str = state.get('synthesized_memory', 'No relevant memories found.')
        retrieved_memory_context = [HumanMessage(content=f"\n--- Relevant Context from Past Conversations ---\n{retrieved_memory_str}\n")]

        # 4. Local Context (短期記憶) の構築
        # 対話履歴の末尾から指定トークン数分のメッセージを取得します。
        max_local_tokens = 4096 
        local_context = []
        current_local_tokens = 0
        for i in range(len(full_history) - 1, -1, -1):
            msg = full_history[i]
            msg_tokens = self.llm_manager.count_tokens_for_messages([msg])
            if current_local_tokens + msg_tokens > max_local_tokens and local_context:
                break
            local_context.insert(0, msg) # 先頭に追加して順序を維持
            current_local_tokens += msg_tokens

        # 5. 全コンテキストの結合
        # 履歴が短い場合（短期記憶が全履歴を含んでいる場合）
        if len(local_context) == len(full_history):
            # [Attention Sink] -> [System/Persona] -> [Retrieved Memory] -> [Full History]
            context_history = attention_sink_context + system_persona_context + retrieved_memory_context + local_context
            print(f"Context: History is short. Using full history as local context ({len(local_context)} messages).")
        else:
            # 履歴が長い場合、省略を示すプロンプトを挿入
            # [Attention Sink] -> [System/Persona] -> [Retrieved Memory] -> ...omitted... -> [Local Context]
            middle_prompt = f"\n... (omitted context, providing relevant memories) ...\n--- Relevant Context from Past Conversations ---\n{retrieved_memory_context}\n... (returning to recent context) ...\n"
            context_history = (
                attention_sink_context + 
                system_persona_context + 
                retrieved_memory_context + 
                [HumanMessage(content=middle_prompt)] + 
                local_context
            )
            print("Context: Using hierarchical structure (Attention Sink > System/Persona > Retrieved > Local).")
            print(f"  - Local Context: {len(local_context)} messages (~{current_local_tokens} tokens)")
            print(f"  - Omitted: {len(full_history) - len(local_context)} messages")

        # --- プロンプト構築とLLM呼び出し ---

        prompt = ChatPromptTemplate.from_messages([
            ("placeholder", "{context_history}"),
            ("human", "<user_input>{input}</user_input>")
        ])

        chain = prompt | llm

        # 論文の「驚き度」計算のためにlogprobsをリクエスト
        response_message = await chain.ainvoke({
            "context_history": context_history,
            "input": state["input"],
        }, config={
            "configurable": {
                "model_kwargs": {
                    "logprobs": True
                }
            }
        })
        
        # 応答からlogprobsを取得
        logprobs = response_message.response_metadata.get("logprobs")

        return {"chat_history": state["chat_history"] + [HumanMessage(content=state["input"]), AIMessage(content=response_message.content)],
                "generation_logprobs": logprobs, # 状態にlogprobsを保存
                }

    async def generate_search_query_node(self, state: AgentState) -> dict:
        """ユーザー入力から検索クエリを要約・生成する。"""
        print("--- Node: Generate Search Query ---")

        # Gemma-3Nをロード
        print("--- Node: Generate Search Query (using Gemma 3N) ---")
        llm = self.llm_manager.get_character_agent()

        prompt = ChatPromptTemplate.from_template(
            "Based on the user's request, generate a concise and effective search query. User request: \"{input}\""
        )
        chain = prompt | llm
        response_message = await chain.ainvoke({"input": state["input"]})

        return {"search_query": response_message.content}
    
    def execute_search_node(self, state: AgentState) -> dict:
        """Google Custom Search APIツールを呼び出して結果を得る。"""
        print("--- Node: Execute Search ---")
        query = state.get("search_query", state["input"])
        
        # Ensure we use ToolManager so the multi-results variant is consistently used
        result = self.tool_manager.execute_tool("native_google_search", {"query": query})
        return {"search_result": result}
    
    async def summarize_search_result_node(self, state: AgentState) -> dict:
        """検索結果をユーザーにわかりやすい要約に変換する。"""
        print("--- Node: Summarize Search Result (Streaming) ---")

        # Gemma-3nをロード
        llm = self.llm_manager.get_character_agent()

        # システム指示はsystemに保持し、humanには変数データのみを渡す
        # ★修正: 全ての変数をプレースホルダーとして渡し、ainvoke時に解決する
        persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]
        system_template = config.BASE_SYSTEM_PROMPTS["search_summary"]

        prompt = ChatPromptTemplate.from_messages([
            ("system", f"{persona}\n\n{system_template}\n\n--- Relevant Context from Past Conversations ---\n{{synthesized_memory}}"),
            ("placeholder", "{chat_history}"),
            ("human", "Please summarize the search results for my request: {original_question}")
        ])

        chain = prompt | llm

        response_message = await chain.ainvoke(
            {
            "chat_history": state["chat_history"],
            "synthesized_memory": state.get('synthesized_memory', 'No relevant memories found.'),
            "original_question": state["input"],
            "search_result": state.get("search_result", "No result found.")
            },
            config={
                "configurable": {
                    "model_kwargs": {
                        "logprobs": True
                    }
                }
            }
        )

        # 応答からlogprobsを取得
        logprobs = response_message.response_metadata.get("logprobs")

        # ストリーミングが完了した後、最終的な完全な応答を状態に設定する。
        return {
            "messages": [AIMessage(content=response_message.content)],
            "chat_history": state["chat_history"] + [HumanMessage(content=state["input"]), AIMessage(content=response_message.content)],
            "generation_logprobs": logprobs, # 状態にlogprobsを保存
        }

    async def synthesize_final_response_node(self, state: AgentState) -> dict:
        """
        ReActループの結果（内部レポート）を、ユーザー向けの自然な応答に変換する。
        """
        print("--- Node: Synthesize Final Response (Streaming) ---")

        # Gemma-3nをロード
        llm = self.llm_manager.get_character_agent()

        # ReActループが生成した内部レポートを取得
        internal_report = state.get("agent_outcome", "No report generated.")
        # ★★★ バグ修正: agent_outcomeがない場合(ReActループがエラーで終了した場合など)のフォールバック処理 ★★★
        if not state.get("agent_outcome"):
            print("WARNING: No agent_outcome found. Synthesizing from scratchpad as a fallback.")
            internal_report = f"The agent could not produce a final report. The following is the internal work log:\n{_format_scratchpad(state['agent_scratchpad'])}"

        print(f"Internal report for synthesis: {internal_report}")
        print(f"Original user input: {state['input']}")

        # システム指示はsystemに保持し、humanには変数データのみを渡す
        # ★修正: 全ての変数をプレースホルダーとして渡し、ainvoke時に解決する
        persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]
        system_template = config.BASE_SYSTEM_PROMPTS["synthesis"]

        prompt = ChatPromptTemplate.from_messages([
            ("system", f"{persona}\n\n{system_template}\n\n--- Relevant Context from Past Conversations ---\n{{synthesized_memory}}"),
            ("placeholder", "{chat_history}"),
            ("human", "Please provide the final response for my request: {original_request}")
        ])

        print(f"\n--- Generating Final Response ---")
        print(f"System prompt being used: synthesis")

        chain = prompt | llm

        response_message = await chain.ainvoke(
            {
            "chat_history": state["chat_history"],
            "synthesized_memory": state.get('synthesized_memory', 'No relevant memories found.'),
            "original_request": state["input"],
            "technical_report": internal_report
            },
            config={
                "configurable": {
                    "model_kwargs": {
                        "logprobs": True
                    }
                }
            }
        )

        # 応答からlogprobsを取得
        logprobs = response_message.response_metadata.get("logprobs")

        # ストリーミングが完了した後、最終的な完全な応答を状態に設定する。
        return {
            "messages": [AIMessage(content=response_message.content)],
            "chat_history": state["chat_history"] + [HumanMessage(content=state["input"]), AIMessage(content=response_message.content)],
            "generation_logprobs": logprobs, # 状態にlogprobsを保存
        }