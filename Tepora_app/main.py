# main.py (EM-LLM統合版)
"""
EM-LLM対応エージェントアプリのエントリーポイント


このファイルは、EM-LLM（Episodic Memory-enhanced Large Language Model）機能を
統合したAIエージェントアプリケーションのエントリーポイントです。
AgentAppクラスがアプリケーションの初期化、実行、クリーンアップのライフサイクルを管理します。
"""

import logging
import os
import re

os.environ["TORCHDYNAMO_DISABLE"] = "1"

import asyncio
import sys
from typing import Any, Dict, List, Optional

from langchain_core.messages import HumanMessage, AIMessage

# EM-LLM関連のインポート
from agent_core.em_llm_core import EMLLMIntegrator, EMConfig
from agent_core.em_llm_graph import EMEnabledAgentCore
from agent_core.embedding_provider import EmbeddingProvider

# 従来のインポート
from agent_core.config import MCP_CONFIG_FILE, MAX_CHAT_HISTORY_TOKENS, EM_LLM_CONFIG
from agent_core.llm_manager import LLMManager
from agent_core.tool_manager import ToolManager
from agent_core.memory.memory_system import MemorySystem
from agent_core.graph import AgentCore

# 定数
CMD_EM_STATS = "/emstats"

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

async def ainput(prompt: str = "") -> str:
    print(prompt, end="", flush=True)
    return await asyncio.to_thread(sys.stdin.readline)

def sanitize_user_input(user_input: str, max_length: int = 10000) -> str:
    """
    ユーザー入力をサニタイズして、潜在的なプロンプトインジェクション攻撃を緩和する。
    """
    if len(user_input) > max_length:
        raise ValueError(f"Input too long: {len(user_input)} > {max_length}")

    # システムプロンプトの注入を試みる可能性のある危険なパターンを検出
    dangerous_patterns = [
        r"ignore\s+previous\s+instructions",
        r"system\s*:",
        r"<\|im_start\|>",
        # さらに追加のパターン...
    ]
    for pattern in dangerous_patterns:
        if re.search(pattern, user_input, re.IGNORECASE):
            logger.warning(f"Potential prompt injection attempt detected in user input: '{user_input[:100]}...'")
            # ここではログ出力に留めるが、将来的には入力を拒否またはフィルタリングすることも可能

    return user_input

async def main():
    """EM-LLM対応エージェントのメイン関数"""
    
    llm_manager = None
    tool_manager = None
    em_llm_integrator = None
    embedding_provider = None # フォールバック時の未定義参照を回避するためにここで初期化
    app = None
    
    try:
        print("Initializing EM-LLM Enhanced AI Agent...")
        print("=" * 60)
        
        # === Phase 1: 基本システム初期化 ===
        print("Phase 1: Initializing core systems...")
        
        # LLMマネージャー初期化
        llm_manager = LLMManager()
        llm_manager.get_character_agent()  # メインLLMをプリロード
        print("✓ LLM Manager initialized")
        
        # ツールマネージャー初期化
        tool_manager = ToolManager(config_file=MCP_CONFIG_FILE)
        tool_manager.initialize()
        print(f"✓ Tool Manager initialized with {len(tool_manager.tools)} tools")
        
        # === Phase 2: EM-LLM システム初期化 ===
        print("\nPhase 2: Initializing EM-LLM systems...")
        
        try:
            # 埋め込みモデルをロード
            embedding_llm = llm_manager.get_embedding_model()
            embedding_provider = EmbeddingProvider(embedding_llm)
            print("✓ Embedding provider initialized")

            # config.pyのキー名がEMConfigのフィールド名と一致しているため、辞書アンパックで簡潔に初期化
            em_config = EMConfig(**EM_LLM_CONFIG)

            # --- キャラクターエージェント用メモリシステムの初期化 ---
            char_em_memory_system = MemorySystem(embedding_provider, db_path="./chroma_db_em_llm", collection_name="em_llm_events_char")
            print("✓ Character EM-LLM memory system initialized")
            char_em_llm_integrator = EMLLMIntegrator(llm_manager, embedding_provider, em_config, char_em_memory_system)

            # --- プロフェッショナルエージェント用メモリシステムの初期化 ---
            prof_em_memory_system = MemorySystem(embedding_provider, db_path="./chroma_db_em_llm", collection_name="em_llm_events_prof")
            print("✓ Professional EM-LLM memory system initialized")
            prof_em_llm_integrator = EMLLMIntegrator(llm_manager, embedding_provider, em_config, prof_em_memory_system)

            # メインのインテグレータとしてキャラクター用を設定
            em_llm_integrator = char_em_llm_integrator

            # EM-LLM対応グラフを構築
            agent_core = EMEnabledAgentCore(
                llm_manager, 
                tool_manager, 
                char_em_llm_integrator, 
                prof_em_llm_integrator
            )
            print("✓ EM-LLM configuration applied")
            print("✓ EM-LLM integrator initialized")
            
        except Exception as e:
            logger.error(f"EM-LLM initialization failed: {e}", exc_info=True)
            print(f"⚠ EM-LLM initialization failed: {e}. Check logs for details.")
            print("Falling back to traditional memory system...")
            em_llm_integrator = None
        
        # === Phase 3: アプリケーショングラフ構築 ===
        print("\nPhase 3: Building application graph...")
        
        if em_llm_integrator:
            app = agent_core.graph
            print("✓ EM-LLM enhanced graph initialized")
            
            # 初期統計を表示
            total_char_events = char_em_llm_integrator.memory_system.count()
            summary = f"{total_char_events} events loaded from persistent storage." if total_char_events > 0 else "Ready (no prior events)."
            print(f"✓ Character EM-LLM Memory: {summary}")
        else:
            # フォールバック: 従来システム
            # EM-LLM初期化中にembedding_providerが正常に初期化されているはずなので、それを再利用する
            if embedding_provider:
                print("Re-using embedding provider for fallback memory system.")
            else: # 何らかの理由でembedding_providerも失敗した場合
                print("⚠ Embedding provider is not available. Fallback memory system will be disabled.")

            if embedding_provider: # 再度チェック
                memory_system = MemorySystem(embedding_provider, db_path="./chroma_db_fallback")
                agent_core = AgentCore(llm_manager, tool_manager, memory_system)
            else:
                agent_core = AgentCore(llm_manager, tool_manager, None)
            app = agent_core.graph
            print("✓ Traditional graph initialized (fallback mode)")
        
        print("=" * 60)
        
    except Exception as e:
        logger.error(f"Critical error during initialization: {e}", exc_info=True)
        print(f"\n❌ Failed to start the AI agent: {e}")
        print("Please check the logs and configuration.")
        return
    
    # === 対話ループ開始 ===
    if em_llm_integrator:
        print("🧠 EM-LLM Enhanced AI Agent is ready!")
        print("Features: Surprise-based memory formation, Two-stage retrieval, Episodic segmentation")
    else:
        print("🤖 AI Agent is ready (traditional mode)")
    
    print("\nCommands:")
    print("  • '/agentmode <request>' - Complex task with tools")  
    print("  • '/search <query>' - Web search")
    print("  • '/emstats' - Character agent's memory statistics (if available)")
    print("  • '/emstats_prof' - Professional agent's memory statistics (if available)")
    print("  • Normal chat - Direct conversation")
    print("  • 'exit' - Quit")
    print("-" * 60)
    
    chat_history = []
    
    try:
        while True:
            try:
                raw_user_input = (await ainput("You: ")).strip()
                
                if raw_user_input.lower() in ["exit", "quit"]:
                    break
                if not raw_user_input:
                    continue
                
                # ユーザー入力のサニタイズ
                try:
                    user_input = sanitize_user_input(raw_user_input)
                except ValueError as e:
                    print(f"Error: {e}")
                    continue
                # EM-LLM統計コマンド処理
                if user_input.lower() == CMD_EM_STATS and em_llm_integrator:
                    try:
                        stats = em_llm_integrator.get_memory_statistics()
                        print("\n📊 EM-LLM Memory System Statistics:")
                        print(f"   Total Events: {stats.get('total_events', 0)}")
                        print(f"   Total Tokens: {stats.get('total_tokens_in_memory', 0)}")
                        print(f"   Mean Event Size: {stats.get('mean_event_size', 0):.1f} tokens")
                        print()
                        
                        surprise_stats = stats.get('surprise_statistics', {})
                        if surprise_stats and surprise_stats.get('mean', 0) > 0:
                            print(f"   Surprise - Mean: {surprise_stats.get('mean', 0):.3f}, "
                                  f"Std: {surprise_stats.get('std', 0):.3f}, Max: {surprise_stats.get('max', 0):.3f}")
                        
                        config_info = stats.get('configuration', {})
                        print(f"   Config - γ: {config_info.get('surprise_gamma', 0)}, "
                              f"Event Size: {config_info.get('min_event_size', 0)}-{config_info.get('max_event_size', 0)}")
                        print()
                        continue
                    except Exception as e:
                        print(f"❌ Failed to retrieve EM-LLM statistics: {e}")
                        continue
                elif user_input.lower() == '/emstats_prof' and prof_em_llm_integrator:
                    try:
                        stats = prof_em_llm_integrator.get_memory_statistics()
                        print("\n📊 Professional Agent EM-LLM Memory Statistics:")
                        print(f"   Total Events: {stats.get('total_events', 0)}")
                        print(f"   Total Tokens: {stats.get('total_tokens_in_memory', 0)}")
                        print(f"   Mean Event Size: {stats.get('mean_event_size', 0):.1f} tokens")
                        print()
                        
                        surprise_stats = stats.get('surprise_statistics', {})
                        if surprise_stats and surprise_stats.get('mean', 0) > 0:
                            print(f"   Surprise - Mean: {surprise_stats.get('mean', 0):.3f}, "
                                  f"Std: {surprise_stats.get('std', 0):.3f}, Max: {surprise_stats.get('max', 0):.3f}")
                        
                        config_info = stats.get('configuration', {})
                        print(f"   Config - γ: {config_info.get('surprise_gamma', 0)}, "
                              f"Event Size: {config_info.get('min_event_size', 0)}-{config_info.get('max_event_size', 0)}")
                        print()
                        continue
                    except Exception as e:
                        print(f"❌ Failed to retrieve Professional Agent EM-LLM statistics: {e}")
                        continue
                
                # LangGraphの実行
                initial_state = {
                    "input": user_input,
                    "chat_history": chat_history,
                    "agent_scratchpad": [],
                    "messages": [],
                }
                
                print(f"\n--- Processing (EM-LLM: {'✓' if em_llm_integrator else '✗'}) ---")
                
                full_response = ""
                final_output = None
                
                # ストリーミング実行
                async for event in app.astream_events(initial_state, version="v2", config={"recursion_limit": 50}):
                    kind = event["event"]
                    
                    # LLMストリーミング出力
                    if kind == "on_chat_model_stream":
                        content = event["data"]["chunk"].content
                        if content:
                            print(content, end="", flush=True)
                            full_response += content
                    
                    # グラフ実行完了
                    elif kind == "on_graph_end":
                        final_output = event["data"]["output"]
                
                print()  # 改行
                
                # チャット履歴更新
                # agent_outcomeがある場合でも、full_responseが生成されていればそれを使う
                if final_output and full_response:
                    chat_history.append(HumanMessage(content=user_input))
                    chat_history.append(AIMessage(content=full_response))
                else:
                    # フォールバック：応答が生成されなかったが、何らかのエラーが発生した場合
                    # ユーザーの入力のみ履歴に追加し、エラーメッセージを表示
                    print("\nAI: An unexpected error occurred.")
                    chat_history.append(HumanMessage(content=user_input))
                
                # チャット履歴のトークン数制限
                try:
                    if llm_manager:
                        current_tokens = llm_manager.count_tokens_for_messages(chat_history)
                        if current_tokens > MAX_CHAT_HISTORY_TOKENS:
                            print(f"INFO: Chat history exceeds token limit ({current_tokens}/{MAX_CHAT_HISTORY_TOKENS}). Truncating...")
                            
                            truncated_history = list(chat_history)
                            # 制限を下回るまで、古いメッセージペア（Human & AI）を削除
                            while llm_manager.count_tokens_for_messages(truncated_history) > MAX_CHAT_HISTORY_TOKENS and len(truncated_history) > 2:
                                truncated_history = truncated_history[2:]
                            
                            chat_history = truncated_history
                            final_tokens = llm_manager.count_tokens_for_messages(chat_history)
                            print(f"INFO: Chat history truncated. Final tokens: {final_tokens}")

                except Exception as e:
                    logger.warning(f"Could not truncate chat history by tokens: {e}. The history may grow unchecked.")

                
            except KeyboardInterrupt:
                print("\n\n👋 Exiting EM-LLM Agent. Goodbye!")
                break
            except Exception as e:
                logger.error(f"Error during conversation: {e}", exc_info=True)
                print(f"\n❌ An error occurred: {e}")
                print("Please try again or type 'exit' to quit.")
            finally:
                print("-" * 60)
    
    finally:
        # === クリーンアップ ===
        print("\n🧹 Cleaning up resources...")
        
        if llm_manager:
            try:
                llm_manager.cleanup()
                print("✓ LLM resources cleaned up")
            except Exception as e:
                print(f"⚠ LLM cleanup warning: {e}")
        
        if tool_manager:
            try:
                tool_manager.cleanup()
                print("✓ Tool manager cleaned up")
            except Exception as e:
                print(f"⚠ Tool manager cleanup warning: {e}")
        
        if em_llm_integrator:
            try:
                stats = em_llm_integrator.get_memory_statistics()
                print(f"✓ Final EM-LLM state: {stats.get('total_events', 0)} events, "
                      f"{stats.get('total_tokens_in_memory', 0)} tokens")
            except Exception as e:
                print(f"⚠ Could not retrieve final EM-LLM statistics: {e}")
        
        print("Cleanup completed.")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        logging.error(f"Failed to run the EM-LLM agent application: {e}", exc_info=True)
        print(f"❌ Critical failure: {e}")
        print("Check logs for details.")