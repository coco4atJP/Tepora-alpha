"""
エージェントアプリのエントリーポイント。

流れ:
1) LLMロード
2) ツール初期化(MCP含む)
3) LangGraphのアプリ(実行グラフ)を構築
4) 対話ループを開始し、ユーザー入力を受け付ける

終了時はリソース(モデル/ツール)を確実に解放する。
"""

# main.py

import logging
import os

os.environ["TORCHDYNAMO_DISABLE"] = "1"

import asyncio
import sys
from langchain_core.messages import HumanMessage, AIMessage
import json
from agent_core.config import MCP_CONFIG_FILE , MAX_CHAT_HISTORY_LENGTH
from agent_core.llm_manager import LLMManager
from agent_core.tool_manager import ToolManager
from agent_core.graph import AgentCore

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

async def ainput(prompt: str = "") -> str:
    # The prompt needs to be printed separately as readline doesn't handle it.
    print(prompt, end="", flush=True)
    return await asyncio.to_thread(sys.stdin.readline)

async def main():
    """
    エージェントの初期化と対話ループを実行するメイン関数。
    
    処理の流れ:
    1. 初期化フェーズ: LLMロード、ツール初期化、グラフ構築
    2. 対話ループフェーズ: ユーザー入力受付、LangGraph実行、結果表示
    3. クリーンアップフェーズ: リソース解放、MCPセッション終了
    """
    # finallyブロックで参照できるよう、Noneで初期化しておきます
    llm_manager = None
    tool_manager = None
    app = None
    
    # --- 1. 初期化フェーズ ---
    # 初期化中に発生した致命的なエラーはここでキャッチします
    try:
        print("Initializing AI Agent...")
        
        # 1a. LLMManagerをインスタンス化
        llm_manager = LLMManager()

        # 1b. 最初にGemmaをロードしておく
        llm_manager.get_gemma_3n()
        
        # 1c. ツールマネージャーを初期化: MCPサーバー起動とツール発見
        tool_manager = ToolManager(config_file=MCP_CONFIG_FILE)
        tool_manager.initialize()
        
        # 1d. エージェントコアを構築し、実行可能なグラフ(app)を取得
        agent_core = AgentCore(llm_manager=llm_manager, tool_manager=tool_manager)
        app = agent_core.graph
    
    except Exception as e:
        logging.error(f"A critical error occurred during agent initialization: {e}", exc_info=True)
        print("\nFailed to start the AI agent. Please check the logs.")
        return # 初期化に失敗した場合はここでプログラムを終了

    print("\n--- AI Agent is ready. Type '/agentmode <your request>' ・ AI Search is ready. Type '/search <your query>' for complex tasks, or a simple chat message. Type 'exit' to quit. ---")

    # --- 2. 対話ループフェーズ ---    
    chat_history = []
    try:
        while True:
            try:
                # 2a. ユーザー入力受付: 終了コマンドと空入力をチェック
                # Use the async input function and strip the trailing newline
                user_input = (await ainput("You: ")).strip()
                if user_input.lower() in ["exit", "quit"]:
                    break
                if not user_input:
                    continue

                # 2b. LangGraphに渡す初期状態を構築
                initial_state = {
                    "input": user_input,
                    "chat_history": chat_history, # 常に最新の履歴を渡す
                    "agent_scratchpad": [],
                    "messages": [],
                }
                
                print(f"\n--- Initial State ---")
                print(f"Input: {initial_state['input']}")
                print(f"Chat history length: {len(initial_state['chat_history'])}")
                
                # 2c. LangGraphの実行: ルーティングとノード処理
                print("\n--- Agent is thinking... ---")

                # 2d. LangGraphのストリーミング実行と結果表示
                full_response = ""
                final_output = None # Will hold the final state from the graph

                # astream_eventsを使用して、より低レベルのイベントをリッスンする
                async for event in app.astream_events(initial_state, version="v2", config={"recursion_limit": 50}):
                    kind = event["event"]
                    
                    # LLMからトークンがストリーミングされるたびにこのイベントが発生
                    if kind == "on_chat_model_stream":
                        content = event["data"]["chunk"].content
                        if content:
                            # 差分をそのまま出力
                            print(content, end="", flush=True)
                            full_response += content
                    
                    # グラフ全体の実行が終了したときのイベント
                    elif kind == "on_graph_end":
                        # 最終的なグラフの出力を保存
                        final_output = event["data"]["output"]

                print()  # ストリーミング出力後の改行

                # 2e. 最終的なチャット履歴でローカルの履歴を更新
                # ストリーミングで応答が正常に生成されたかを第一に確認する
                if full_response:
                    # ユーザーの入力と、ストリーミングで得られたAIの完全な応答を履歴に追加
                    chat_history.append(HumanMessage(content=user_input))
                    chat_history.append(AIMessage(content=full_response))
                # ストリーミングは無かったが、ReActループが何らかの結果を返した場合
                elif final_output and "agent_outcome" in final_output and final_output.get("agent_outcome"):
                    print(f"\nAI: (Task completed, but no final response was generated. Outcome: {final_output['agent_outcome']})")
                    # この場合もユーザーの入力は履歴に残す
                    chat_history.append(HumanMessage(content=user_input))
                else:
                    # ストリーミングもfinal_outputも得られなかった場合のフォールバック
                    print("\nAI: An unexpected error occurred and no response was generated.")
                    chat_history.append(HumanMessage(content=user_input))

                # チャット履歴が上限を超えたら古いものから削除
                if len(chat_history) > MAX_CHAT_HISTORY_LENGTH:
                    print(f"INFO: Chat history truncated from {len(chat_history)} to {MAX_CHAT_HISTORY_LENGTH} messages.")
                    chat_history = chat_history[-MAX_CHAT_HISTORY_LENGTH:]
                
                print("\n-----------------------------------------\n")

            except KeyboardInterrupt:
                print("\nExiting agent. Goodbye!")
                break
            except Exception as e:
                logging.error(f"An error occurred during the conversation loop: {e}", exc_info=True)
                print("\nAn error occurred. Please try again or type 'exit' to quit.")

    # --- 3. クリーンアップフェーズ ---
    # プログラム終了時にリソースを解放します
    finally:
        print("Cleaning up resources...")
        # 3a. LLMのVRAM解放: モデルとトークナイザーを削除
        if llm_manager:
            try:
                llm_manager.cleanup()
            except Exception as e:
                print(f"ERROR: Failed to cleanup LLM manager: {e}")
        # 3b. ツールマネージャーのクリーンアップ: MCPセッション終了、イベントループ停止
        if tool_manager:
            try:
                tool_manager.cleanup()
            except Exception as e:
                print(f"ERROR: Failed to cleanup tool manager: {e}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        logging.error(f"Failed to run the agent application: {e}", exc_info=True)