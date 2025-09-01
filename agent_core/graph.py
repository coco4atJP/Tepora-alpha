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
from typing import Literal, List

from langchain_core.messages import AIMessage, ToolMessage, BaseMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import BaseTool
from langgraph.graph import StateGraph, END

from .state import AgentState
from .tool_manager import ToolManager
from .llm_manager import LLMManager
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

# --- Graph Definition ---
def route_by_command(state: AgentState) -> Literal["agent_mode", "search", "direct_answer"]:
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

class AgentCore:
    """アプリ全体の実行グラフを組み立て、実行するためのファサード。"""
    def __init__(self, llm_manager: LLMManager, tool_manager: ToolManager):
        self.llm_manager = llm_manager
        self.tool_manager = tool_manager
        self.graph = self._build_graph()

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

        workflow.add_node("direct_answer", self.direct_answer_node)
        workflow.add_node("generate_search_query", self.generate_search_query_node)
        workflow.add_node("execute_search", self.execute_search_node)
        workflow.add_node("summarize_search_result", self.summarize_search_result_node)
        workflow.add_node("agent_reasoning_node", self.agent_reasoning_node)
        workflow.add_node("synthesize_final_response_node", self.synthesize_final_response_node)
        workflow.add_node("tool_node", self.unified_tool_executor_node) 
        workflow.add_node("update_scratchpad_node", self.update_scratchpad_node)
        workflow.add_node("generate_order_node", self.generate_order_node)
        
        workflow.set_conditional_entry_point(route_by_command, {
            "agent_mode": "generate_order_node", "search": "generate_search_query", "direct_answer": "direct_answer",
        })

        workflow.add_edge("direct_answer", END)
        workflow.add_edge("generate_search_query", "execute_search")
        workflow.add_edge("execute_search", "summarize_search_result")
        workflow.add_edge("summarize_search_result", END)
        workflow.add_edge("generate_order_node", "agent_reasoning_node")

        workflow.add_conditional_edges(
            "agent_reasoning_node",
            self.should_continue_react_loop,
            {
                "continue": "tool_node", 
                "end": "synthesize_final_response_node" 
            },
        )
        workflow.add_edge("tool_node", "update_scratchpad_node")
        workflow.add_edge("update_scratchpad_node", "agent_reasoning_node")

        # 応答生成ノードが最後のステップとなる
        workflow.add_edge("synthesize_final_response_node", END)
        
        return workflow.compile()

    # --- ReAct Loop Nodes ---

    def generate_order_node(self, state: AgentState) -> dict:
        """
        キャラクター・エージェント(Gemma)が、ユーザーの要求をプロフェッショナル向けの「オーダー」に変換する。
        """
        print("--- Node: Generate Order (using Gemma 3N) ---")
        llm = self.llm_manager.get_gemma_3n()
        
        # オーダー生成専用のプロンプトを使用
        prompt = ChatPromptTemplate.from_messages([
            ("system", config.BASE_SYSTEM_PROMPTS["order_generation"]),
            ("human", "User Request: {input}\n\nAvailable Tools:\n{tools}\n\nPlease generate the JSON order now.")
        ])
        chain = prompt | llm

        response_message = chain.invoke({
            "input": state["input"],
            # Use the method from ToolManager directly
            "tools": self.tool_manager.format_tools_for_react_prompt()
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
        llm = self.llm_manager.get_jan_nano()

        # 1. ReActループの開始時にscratchpadを初期化
        if not state["agent_scratchpad"]:
            print("Initializing agent_scratchpad for new ReAct loop")
            state["agent_scratchpad"] = []
        
        # 2. 過去の思考・ツール実行履歴を文字列に整形
        scratchpad_str = _format_scratchpad(state["agent_scratchpad"])
        print(f"Current scratchpad: {scratchpad_str}")
        
        # 3. REACT_SYSTEM_PROMPTでLLMに思考とツール使用を指示
        prompt = ChatPromptTemplate.from_messages([
            ("system", config.BASE_SYSTEM_PROMPTS["react_professional"]),
            ("human", "A user has made the following request:\nUser Request: {user_input}\n\nBased on this, the following order has been generated for you to execute:\nOrder: {order}\n\nHere is the history of your work on this order:\n{agent_scratchpad}")
        ])
        chain = prompt | llm

        print(f"Available tools: {[tool.name for tool in self.tool_manager.tools]}")

        print("\n--- LLM Processing ---")
        print(f"User Input for ReAct: {state['input']}")
        print(f"Scratchpad: {scratchpad_str}")
        
        response_message = chain.invoke({
            "tools": self.tool_manager.format_tools_for_react_prompt(),
            "user_input": state["input"],
            "order": json.dumps(state.get("order", {})),
            "agent_scratchpad": _format_scratchpad(state["agent_scratchpad"])
        })
        
        print(f"\n--- LLM Raw Output ---")
        print(f"Response content: {response_message.content}")
        
        try:
            # 4. LLMの出力をJSONとして解析
            content_str = response_message.content
            if content_str.startswith("```json"):
                content_str = content_str[7:-3].strip()
                print(f"Extracted JSON content: {content_str}")
            
            parsed_json = json.loads(content_str)
            print(f"\n--- Parsed JSON ---")
            print(f"Parsed successfully: {json.dumps(parsed_json, indent=2, ensure_ascii=False)}")

            # 5. "action"の場合はツール呼び出しメッセージを作成
            if "action" in parsed_json:
                action = parsed_json["action"]
                print(f"\n--- Action Detected ---")
                print(f"Tool: {action['tool_name']}")
                print(f"Args: {action.get('args', 'No arguments')}") 
                print(f"Thought: {parsed_json.get('thought', 'No thought provided')}")
                
                # ツール呼び出し用のAIMessageを作成
                tool_call_message = AIMessage(
                    content=parsed_json.get("thought", ""),
                    tool_calls=[{
                        "name": action["tool_name"], "args": action.get("args", {}), "id": f"tool_call_{len(state['agent_scratchpad'])}"
                    }]
                )
                
                print(f"\n--- Tool Call Message Created ---")
                print(f"Content: {tool_call_message.content}")
                print(f"Tool calls: {tool_call_message.tool_calls}")
                
                # 指示書を「記録棚」と「郵便受け」の両方に入れる
                return {
                    "agent_scratchpad": state["agent_scratchpad"] + [tool_call_message],
                    "messages": [tool_call_message] # ToolNodeは最後のメッセージしか見ないので、上書きでOK
                }

            # 6. "finish"の場合はループ終了として結果を返却
            elif "finish" in parsed_json:
                answer = parsed_json["finish"]["answer"]
                print(f"\n--- Finish Action Detected ---")
                print(f"Final answer: {answer}")
                return {"agent_outcome": answer, "messages": []} # ループ終了時はmessagesをクリア
            
            else:
                raise ValueError("Invalid JSON: missing 'action' or 'finish' key.")

        except (json.JSONDecodeError, ValueError) as e:
            # 7. エラー時は自己修正を促すメッセージをscratchpadに追加
            print(f"\n--- Error Parsing LLM Output ---")
            print(f"Error: {e}")
            print(f"Raw content that failed to parse: {response_message.content}")
            # エラーをAIMessageとしてscratchpadに追加し、LLMに自己修正を促す
            error_ai_message = AIMessage(content=f"My last attempt failed. The response was not valid JSON. Error: {e}. I must correct my output to be a single valid JSON object.")
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

    async def direct_answer_node(self, state: AgentState):
        """シンプルなシステムプロンプトで一往復の応答を生成する。"""
        print("--- Node: Direct Answer (Streaming) ---")

        # Gemma-3Nをロード
        llm = self.llm_manager.get_gemma_3n()
        # ペルソナとシステムプロンプトを結合
        persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]
        system_prompt = config.BASE_SYSTEM_PROMPTS["direct_answer"]
        full_prompt = f"{persona}\n\n{system_prompt}"
        
        prompt = ChatPromptTemplate.from_messages([
            ("system", full_prompt),
            ("placeholder", "{chat_history}"),
            ("human", "{input}")
        ])

        # ユーザーの入力をまず履歴に追加
        current_history = state["chat_history"] + [HumanMessage(content=state["input"])]
        
        # プロンプトを手動でレンダリングし、llm.astreamを直接呼び出す
        messages = prompt.format_messages(
            chat_history=state["chat_history"], 
            input=state["input"]
        )

        full_response_content = ""
        # astreamを使ってLLMからの応答をチャンクで受け取る
        async for chunk in llm.astream(messages):
            full_response_content += chunk.content
            # 途中の状態をyieldでストリーミング
            yield {"chat_history": current_history + [AIMessage(content=full_response_content)]}
    
    async def generate_search_query_node(self, state: AgentState) -> dict:
        """ユーザー入力から検索クエリを要約・生成する。"""
        print("--- Node: Generate Search Query ---")

        # Gemma-3Nをロード
        print("--- Node: Generate Search Query (using Gemma 3N) ---")
        llm = self.llm_manager.get_gemma_3n()

        prompt = f"Based on the user's request, generate a concise and effective search query. User request: \"{state['input']}\""
        response_message = await llm.ainvoke(prompt)

        return {"search_query": response_message.content}
    
    def execute_search_node(self, state: AgentState) -> dict:
        """Google Custom Search APIツールを呼び出して結果を得る。"""
        print("--- Node: Execute Search ---")
        query = state.get("search_query", state["input"])
        
        # Ensure we use ToolManager so the multi-results variant is consistently used
        result = self.tool_manager.execute_tool("native_google_search", {"query": query})
        return {"search_result": result}
    
    async def summarize_search_result_node(self, state: AgentState):
        """検索結果をユーザーにわかりやすい要約に変換する。"""
        print("--- Node: Summarize Search Result (Streaming) ---")

        # Gemma-3nをロード
        llm = self.llm_manager.get_gemma_3n()

        # システム指示はsystemに保持し、humanには変数データのみを渡す
        persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]
        system_template = config.BASE_SYSTEM_PROMPTS["search_summary"]

        prompt = ChatPromptTemplate.from_messages([
            ("system", f"{persona}\n\n{system_template}"),
            ("human", "Original question: {original_question}\nSearch results: {search_result}"),
        ])

        # ユーザーの入力をまず履歴に追加
        current_history = state["chat_history"] + [HumanMessage(content=state["input"])]
        
        # プロンプトを手動でレンダリングし、llm.astreamを直接呼び出す
        messages = prompt.format_messages(
            chat_history=state["chat_history"],
            original_question=state["input"],
            search_result=state.get("search_result", "No result found.")
        )

        full_response_content = ""
        async for chunk in llm.astream(messages):
            full_response_content += chunk.content
            yield {"chat_history": current_history + [AIMessage(content=full_response_content)]}
    
    async def synthesize_final_response_node(self, state: AgentState):
        """
        ReActループの結果（内部レポート）を、ユーザー向けの自然な応答に変換する。
        """
        print("--- Node: Synthesize Final Response (Streaming) ---")

        # Gemma-3nをロード
        llm = self.llm_manager.get_gemma_3n()

        # ReActループが生成した内部レポートを取得
        internal_report = state.get("agent_outcome", "No report generated.")
        # ★★★ バグ修正: agent_outcomeがない場合(ReActループがエラーで終了した場合など)のフォールバック処理 ★★★
        if not state.get("agent_outcome"):
            print("WARNING: No agent_outcome found. Synthesizing from scratchpad as a fallback.")
            internal_report = f"The agent could not produce a final report. The following is the internal work log:\n{_format_scratchpad(state['agent_scratchpad'])}"

        print(f"Internal report for synthesis: {internal_report}")
        print(f"Original user input: {state['input']}")

        # システム指示はsystemに保持し、humanには変数データのみを渡す
        persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]
        system_template = config.BASE_SYSTEM_PROMPTS["synthesis"]

        prompt = ChatPromptTemplate.from_messages([
            ("system", f"{persona}\n\n{system_template}"),
            ("human", "original_request: {original_request}\ntechnical_report: {technical_report}"),
        ])

        print(f"\n--- Generating Final Response ---")
        print(f"System prompt being used: synthesis")

        # ユーザーの入力をまず履歴に追加
        current_history = state["chat_history"] + [HumanMessage(content=state["input"])]

        # プロンプトを手動でレンダリングし、llm.astreamを直接呼び出す
        messages = prompt.format_messages(
            chat_history=state["chat_history"],
            original_request=state["input"],
            technical_report=internal_report
        )

        full_response_content = ""
        async for chunk in llm.astream(messages):
            full_response_content += chunk.content
            yield {"chat_history": current_history + [AIMessage(content=full_response_content)]}