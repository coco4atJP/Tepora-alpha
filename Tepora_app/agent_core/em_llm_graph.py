# agent_core/em_llm_graph.py
"""
既存のLangGraphシステムにEM-LLMを統合するための修正版グラフ実装

主な変更点:
1. memory_retrieval_node: 従来のRAG検索をEM-LLMの2段階検索に置換
2. memory_synthesis_node: SLMによる記憶統合はそのまま活用
3. save_memory_node: 従来のメモリ保存をEM-LLMメモリ形成に置換
4. EM-LLM統計情報の追加

従来システムとの互換性を保ちながら、段階的にEM-LLM機能を導入します。
"""

import asyncio
import json
import logging
from typing import Any, Dict, List

from langchain_core.messages import AIMessage, HumanMessage, BaseMessage
from langchain_core.prompts import ChatPromptTemplate

from . import config

logger = logging.getLogger(__name__)


class _GraphNodes:
    """LangGraphのノード名を定義する定数クラス"""
    EM_MEMORY_RETRIEVAL = "em_memory_retrieval"
    EM_MEMORY_FORMATION = "em_memory_formation"
    # 統計ノードはキャラクター用とプロフェッショナル用で共有
    EM_STATS = "em_stats_node"


class _GraphRoutes:
    """LangGraphのルーティング条件を定義する定数クラス"""
    AGENT_MODE = "agent_mode"
    SEARCH = "search"
    DIRECT_ANSWER = "direct_answer"
    # 統計コマンド用のルートを追加
    STATS = "stats"

class EMEnabledAgentCore:
    """EM-LLM機能を統合した新しいAgentCoreクラス"""
    
    def __init__(self, llm_manager, tool_manager, char_em_llm_integrator, prof_em_llm_integrator=None):
        self.llm_manager = llm_manager
        self.tool_manager = tool_manager
        # キャラクター用とプロフェッショナル用のIntegratorを保持
        self.char_em_llm_integrator = char_em_llm_integrator
        # プロフェッショナル用がない場合はキャラクター用でフォールバック
        self.prof_em_llm_integrator = prof_em_llm_integrator if prof_em_llm_integrator else char_em_llm_integrator

        # 従来の機能は保持
        from .graph import AgentCore
        # EM-LLMグラフではAgentCoreのメモリ関連ノードは使用しないため、
        # memory_system引数なしで初期化する。
        self.base_agent_core = AgentCore(llm_manager, tool_manager)
        
        # グラフを再構築（EM-LLMノードで置換）
        self.graph = self._build_em_llm_graph()
        
        logger.info("EM-LLM enabled Agent Core initialized")
    
    def _build_em_llm_graph(self):
        """EM-LLM機能を統合したグラフを構築"""
        from langgraph.graph import StateGraph, END
        from .state import AgentState
        
        base_core = self.base_agent_core
        workflow = StateGraph(AgentState)
        
        # --- ノードの登録 ---
        # 1. EM-LLM専用ノード
        workflow.add_node(_GraphNodes.EM_MEMORY_RETRIEVAL, self.em_memory_retrieval_node)
        workflow.add_node(_GraphNodes.EM_MEMORY_FORMATION, self.em_memory_formation_node)
        workflow.add_node(_GraphNodes.EM_STATS, self.em_stats_node)
        
        # 2. 従来のAgentCoreから流用するノード
        workflow.add_node("direct_answer", base_core.direct_answer_node)
        workflow.add_node("execute_search", base_core.execute_search_node)
        workflow.add_node("summarize_search_result", base_core.summarize_search_result_node)
        workflow.add_node("generate_order_node", base_core.generate_order_node)
        workflow.add_node("agent_reasoning_node", base_core.agent_reasoning_node)
        workflow.add_node("synthesize_final_response_node", base_core.synthesize_final_response_node)
        workflow.add_node("tool_node", base_core.unified_tool_executor_node)
        workflow.add_node("update_scratchpad_node", base_core.update_scratchpad_node)
        workflow.add_node("generate_search_query", base_core.generate_search_query_node)
        
        # --- グラフの接続 ---
        # 1. エントリーポイントはEM-LLMの記憶検索から
        workflow.set_entry_point(_GraphNodes.EM_MEMORY_RETRIEVAL)
        
        # 2. 記憶検索後、コマンドに基づいてルーティングする
        workflow.add_conditional_edges(
            _GraphNodes.EM_MEMORY_RETRIEVAL,
            base_core.route_by_command,
            {
                _GraphRoutes.AGENT_MODE: "generate_order_node",
                _GraphRoutes.SEARCH: "generate_search_query",
                _GraphRoutes.DIRECT_ANSWER: "direct_answer",
                _GraphRoutes.STATS: _GraphNodes.EM_STATS, # 統計コマンド用のエッジを追加
            }
        )
        
        # 3. 各ブランチのフロー
        # Direct Answer と Search のフローは記憶形成ノードに繋がる
        workflow.add_edge("direct_answer", _GraphNodes.EM_MEMORY_FORMATION)
        workflow.add_edge("generate_search_query", "execute_search")
        workflow.add_edge("execute_search", "summarize_search_result")
        workflow.add_edge("summarize_search_result", _GraphNodes.EM_MEMORY_FORMATION)
        
        # AgentMode (ReAct) パス
        workflow.add_edge("generate_order_node", "agent_reasoning_node")
        workflow.add_conditional_edges(
            "agent_reasoning_node",
            base_core.should_continue_react_loop,
            {
                "continue": "tool_node",
                "end": "synthesize_final_response_node"
            },
        )
        workflow.add_edge("tool_node", "update_scratchpad_node")
        workflow.add_edge("update_scratchpad_node", "agent_reasoning_node")
        # AgentModeの最終応答生成後も、他のモードと同様に記憶形成ノードに接続する。
        # これにより、エージェントが実行したタスクの結果も対話記憶として保持される。
        workflow.add_edge("synthesize_final_response_node", _GraphNodes.EM_MEMORY_FORMATION) # 修正なし、EM_MEMORY_FORMATIONに接続
        
        # 4. 記憶形成後、統計情報を確認して終了
        workflow.add_edge(_GraphNodes.EM_MEMORY_FORMATION, _GraphNodes.EM_STATS)
        workflow.add_edge(_GraphNodes.EM_STATS, END)
        
        return workflow.compile()
    
    def _get_active_integrator(self, state: dict):
        """現在の実行モードに基づいて、アクティブなEM-LLM Integratorを返す。"""
        user_input = state.get("input", "").strip().lower()
        # /emstats_prof コマンドもプロフェッショナルモードとして扱う
        if user_input.startswith('/agentmode') or user_input.startswith('/emstats_prof'):
            print("--- Integrator: Professional Mode ---")
            return self.prof_em_llm_integrator
        else:
            print("--- Integrator: Character Mode ---")
            return self.char_em_llm_integrator

    def em_memory_retrieval_node(self, state) -> dict:
        """
        【EM-LLMバージョン】関連エピソード記憶の2段階検索
        
        論文のアーキテクチャに基づき、検索されたイベントを後続ノードが直接利用できるように
        `synthesized_memory` キーに格納します。
        モードに応じて適切なメモリから検索します。
        """
        print("--- Node: EM-LLM Memory Retrieval (Two-Stage) ---")
        
        try:
            # EM-LLMの2段階検索を実行
            active_integrator = self._get_active_integrator(state)
            recalled_events_dict = active_integrator.retrieve_relevant_memories_for_query(state["input"])
            
            if recalled_events_dict:
                print(f"EM-LLM retrieved {len(recalled_events_dict)} relevant episodic events.")
                # 統計情報をログ出力
                for i, event in enumerate(recalled_events_dict):
                    surprise_stats = event.get('surprise_stats', {})
                    print(f"  Event {i+1}: {event.get('content', '')[:50]}... "
                          f"(surprise: {surprise_stats.get('mean_surprise', 0):.3f})")

                # 後続ノードが直接利用できるように、イベントリストを文字列にフォーマットする
                formatted_memory = self._format_episodes_for_context(recalled_events_dict)
                
                return {
                    "recalled_episodes": recalled_events_dict, # ログやデバッグ用に保持
                    "synthesized_memory": formatted_memory
                }
            else:
                print("No relevant episodic memories found.")
                return {"recalled_episodes": [], "synthesized_memory": "No relevant episodic memories found."}
                
        except Exception as e:
            # Catching specific errors can be more helpful, but for a graph node,
            # a general catch-all is often necessary to prevent the entire graph from failing.
            # We log the full exception info for debugging.
            error_message = f"EM-LLM memory retrieval failed: {e}"
            print(f"Warning: {error_message}")
            logger.error(error_message, exc_info=True)
            return {"recalled_episodes": [], "synthesized_memory": "An error occurred during memory retrieval."}
    
    def _format_episodes_for_context(self, episodes: List[Dict]) -> str:
        """検索されたエピソードをLLMのコンテキスト用の文字列にフォーマットする"""
        if not episodes:
            return "No relevant episodic memories found."
        
        return "\n\n".join([
            f"Recalled Event {i+1} (Surprise Score: {ep.get('surprise_stats', {}).get('mean_surprise', 0):.3f}):\n{ep.get('content', 'N/A')}"
            for i, ep in enumerate(episodes)
        ])

    async def _form_memory_with_surprisal(self, logprobs: Dict[str, Any], state: Dict[str, Any]) -> List[Any]:
        """
        驚き度（Surprisal）ベースで記憶を形成する。（論文の主要な方法）
        """
        print(f"  - Analyzing {len(logprobs['content'])} tokens using surprisal-based segmentation.")
        active_integrator = self._get_active_integrator(state) # stateを渡すように修正
        return await active_integrator.process_logprobs_for_memory(
            logprobs['content']
        )

    async def _form_memory_with_semantic_change(self, state: Dict[str, Any], ai_response: str) -> List[Any]:
        """
        意味的変化（Semantic Change）ベースで記憶を形成する。（フォールバック）
        """
        print("  - Warning: Logprobs not available. Falling back to semantic change-based segmentation.")
        print(f"  - Analyzing AI response for semantic change to form episodic memories.")
        print(f"  - Target text (first 150 chars): {ai_response[:150]}...")
        active_integrator = self._get_active_integrator(state)
        return await active_integrator.process_conversation_turn_for_memory(
            state.get("input"), ai_response
        )

    def _log_formation_stats(self, formed_events: List[Any]):
        """
        形成されたイベントの統計情報をログに出力するヘルパー関数。
        """
        if not formed_events:
            print("No episodic events were formed from this conversation turn.")
            return

        total_tokens = sum(len(getattr(event, 'tokens', [])) for event in formed_events)
        
        # 平均驚き度を安全に計算
        total_surprise = 0
        event_count_with_surprise = 0
        for event in formed_events:
            scores = getattr(event, 'surprise_scores', [])
            if scores:
                total_surprise += sum(scores) / len(scores)
                event_count_with_surprise += 1
        
        avg_surprise = total_surprise / event_count_with_surprise if event_count_with_surprise > 0 else 0

        print(f"EM-LLM formed {len(formed_events)} new episodic events from the AI response.")
        print(f"  - Total tokens: {total_tokens}")
        print(f"  - Average surprise: {avg_surprise:.3f}")

    async def em_memory_formation_node(self, state) -> dict:
        """
        【EM-LLMバージョン】対話の記憶形成（非同期実行）
        
        LLMからlogprobsが取得できれば、論文の主要なアプローチである「驚き度ベース」の
        記憶形成を行います。取得できなければ、フォールバックとして「意味的変化ベース」の
        記憶形成を実行します。
        """
        print()
        print("--- Node: EM-LLM Memory Formation (Direct) ---")

        # 必要なデータをstateから取得
        logprobs = state.get("generation_logprobs")
        ai_response_message = next((msg for msg in reversed(state.get("chat_history", [])) if isinstance(msg, AIMessage)), None)
        ai_response = ai_response_message.content if ai_response_message else None

        if not ai_response:
            print("  - Warning: Could not find AI response. Skipping EM-LLM memory formation.")
            return {}

        print("Starting EM-LLM memory formation...")
        formed_events = []
        try:
            # logprobsが利用可能かチェックし、適切な記憶形成メソッドを呼び出す
            if logprobs and logprobs.get("content"):
                formed_events = await self._form_memory_with_surprisal(logprobs, state) # stateを渡す
            else:
                formed_events = await self._form_memory_with_semantic_change(state, ai_response)
            
            # 形成されたイベントの統計情報をログに出力
            self._log_formation_stats(formed_events)

        except Exception as e:
            error_message = f"EM-LLM memory formation error: {e}"
            print(f"  - Error: {error_message}")
            logger.error(error_message, exc_info=True)
        
        print("Memory formation completed. Graph continues.")
        return {}
    
    def em_stats_node(self, state) -> dict:
        """EM-LLMシステムの統計情報を表示（デバッグ用）"""
        print("--- Node: EM-LLM Statistics ---")
        
        try:
            active_integrator = self._get_active_integrator(state)
            stats = active_integrator.get_memory_statistics()
            print("EM-LLM Memory System Statistics:")
            print(f"  Total Events: {stats.get('total_events', 0)}")
            print(f"  Total Tokens in Memory: {stats.get('total_tokens_in_memory', 0)}")
            print(f"  Mean Event Size: {stats.get('mean_event_size', 0):.1f} tokens")
            
            surprise_stats = stats.get('surprise_statistics', {})
            if surprise_stats:
                print(f"  Surprise Stats - Mean: {surprise_stats.get('mean', 0):.3f}, "
                      f"Std: {surprise_stats.get('std', 0):.3f}, Max: {surprise_stats.get('max', 0):.3f}")
            
            config_info = stats.get('configuration', {})
            print(f"  Configuration - Gamma: {config_info.get('surprise_gamma', 0)}, "
                  f"Event Size: {config_info.get('min_event_size', 0)}-{config_info.get('max_event_size', 0)}")
            
        except Exception as e:
            print(f"Warning: Failed to retrieve EM-LLM statistics: {e}")
            logger.warning(f"Could not get EM-LLM statistics: {e}", exc_info=True)
        
        return {}