# web_server.py
"""
Tepora Web Server - FastAPI + WebSocket対応

将来的にElectronでラップしてデスクトップアプリ化可能な構成。
"""

import asyncio
import json
import logging
import os
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from Tepora_app.agent_core.config import MCP_CONFIG_FILE, MAX_CHAT_HISTORY_TOKENS, EM_LLM_CONFIG
from Tepora_app.agent_core.llm_manager import LLMManager
from Tepora_app.agent_core.tool_manager import ToolManager
from Tepora_app.agent_core.memory.memory_system import MemorySystem
from Tepora_app.agent_core.em_llm_core import EMLLMIntegrator, EMConfig
from Tepora_app.agent_core.em_llm_graph import EMEnabledAgentCore
from Tepora_app.agent_core.embedding_provider import EmbeddingProvider
from Tepora_app.agent_core.graph import AgentCore

from langchain_core.messages import HumanMessage, AIMessage

os.environ["TORCHDYNAMO_DISABLE"] = "1"

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# FastAPIアプリケーション
app = FastAPI(title="Tepora AI Agent", version="1.0.0")

# CORS設定（開発環境用）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],  # Vite/React開発サーバー
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# グローバル状態
class AppState:
    def __init__(self):
        self.llm_manager: Optional[LLMManager] = None
        self.tool_manager: Optional[ToolManager] = None
        self.agent_core = None
        self.em_llm_integrator: Optional[EMLLMIntegrator] = None
        self.prof_em_llm_integrator: Optional[EMLLMIntegrator] = None
        self.chat_history = []
        self.initialized = False

app_state = AppState()


# リクエスト/レスポンスモデル
class ChatMessage(BaseModel):
    message: str
    mode: str = "direct"  # direct, search, agent


class SystemStatus(BaseModel):
    initialized: bool
    em_llm_enabled: bool
    total_messages: int
    char_memory_events: int
    prof_memory_events: int


@app.on_event("startup")
async def startup_event():
    """アプリケーション起動時の初期化"""
    logger.info("🚀 Tepora Web Server starting up...")
    
    try:
        # LLMマネージャーの初期化
        logger.info("Initializing LLM Manager...")
        app_state.llm_manager = LLMManager()
        
        # ツールマネージャーの初期化
        logger.info("Initializing Tool Manager...")
        app_state.tool_manager = ToolManager(MCP_CONFIG_FILE)
        
        # EM-LLM統合の初期化
        embedding_provider = None
        try:
            logger.info("Initializing EM-LLM system...")
            
            # 埋め込みプロバイダーの初期化
            embedding_llm = app_state.llm_manager.get_embedding_model()
            embedding_provider = EmbeddingProvider(embedding_llm)
            
            # EM-LLM設定の初期化
            em_config = EMConfig(**EM_LLM_CONFIG)

            # キャラクター用メモリシステムと統合器の初期化
            char_memory_system = MemorySystem(embedding_provider, db_path="./chroma_db_em_llm", collection_name="em_llm_events_char")
            app_state.em_llm_integrator = EMLLMIntegrator(app_state.llm_manager, embedding_provider, em_config, char_memory_system)
            logger.info("✅ Character EM-LLM system initialized.")

            # プロフェッショナル用メモリシステムと統合器の初期化
            prof_memory_system = MemorySystem(embedding_provider, db_path="./chroma_db_em_llm", collection_name="em_llm_events_prof")
            app_state.prof_em_llm_integrator = EMLLMIntegrator(app_state.llm_manager, embedding_provider, em_config, prof_memory_system)
            logger.info("✅ Professional EM-LLM system initialized.")
            
            # EM-LLM対応グラフの構築
            app_state.agent_core = EMEnabledAgentCore(
                app_state.llm_manager,
                app_state.tool_manager,
                app_state.em_llm_integrator,
                app_state.prof_em_llm_integrator
            )
            
            logger.info("✅ EM-LLM system initialized successfully!")
            
        except Exception as e:
            logger.warning(f"⚠️ EM-LLM initialization failed: {e}")
            logger.info("Falling back to traditional agent core...")

            # EM-LLM失敗時は統合器を破棄しておく
            app_state.em_llm_integrator = None
            app_state.prof_em_llm_integrator = None

            # フォールバック: 従来のエージェントコア
            try:
                if embedding_provider is None:
                    embedding_llm = app_state.llm_manager.get_embedding_model()
                    embedding_provider = EmbeddingProvider(embedding_llm)
            except Exception as fallback_embed_error:
                logger.error(
                    "Failed to initialize embedding provider for fallback mode: %s",
                    fallback_embed_error,
                    exc_info=True,
                )
                embedding_provider = None

            memory_system = None
            if embedding_provider:
                try:
                    memory_system = MemorySystem(embedding_provider, db_path="./chroma_db")
                except Exception as memory_error:
                    logger.error("Failed to initialize fallback memory system: %s", memory_error, exc_info=True)

            app_state.agent_core = AgentCore(
                app_state.llm_manager,
                app_state.tool_manager,
                memory_system
            )
        
        app_state.initialized = True
        logger.info("✅ Tepora Web Server ready!")
        
    except Exception as e:
        logger.error(f"❌ Failed to initialize Tepora: {e}", exc_info=True)
        raise


@app.on_event("shutdown")
async def shutdown_event():
    """アプリケーション終了時のクリーンアップ"""
    logger.info("🛑 Tepora Web Server shutting down...")
    
    if app_state.llm_manager:
        app_state.llm_manager.cleanup()
    
    if app_state.tool_manager:
        app_state.tool_manager.cleanup()
    
    logger.info("✅ Cleanup complete")


@app.get("/api/health")
async def health_check():
    """ヘルスチェックエンドポイント"""
    return {
        "status": "healthy",
        "initialized": app_state.initialized
    }


@app.get("/api/status")
async def get_status() -> SystemStatus:
    """システムステータスの取得"""
    char_memory_events = 0
    prof_memory_events = 0

    if app_state.em_llm_integrator:
        try:
            stats = app_state.em_llm_integrator.get_memory_statistics()
            char_memory_events = stats.get("total_events", 0)
        except:
            pass
    if app_state.prof_em_llm_integrator:
        try:
            stats = app_state.prof_em_llm_integrator.get_memory_statistics()
            prof_memory_events = stats.get("total_events", 0)
        except:
            pass
    
    return SystemStatus(
        initialized=app_state.initialized,
        em_llm_enabled=app_state.em_llm_integrator is not None,
        total_messages=len(app_state.chat_history),
        char_memory_events=char_memory_events,
        prof_memory_events=prof_memory_events
    )


@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    """WebSocketチャットエンドポイント（ストリーミング応答）"""
    await websocket.accept()
    logger.info("WebSocket connection established")
    
    try:
        while True:
            # クライアントからのメッセージを受信
            data = await websocket.receive_text()
            message_data = json.loads(data)
            
            user_message = message_data.get("message", "")
            mode = message_data.get("mode", "direct")
            
            if not user_message:
                await websocket.send_json({
                    "type": "error",
                    "message": "Empty message received"
                })
                continue
            
            logger.info(f"Received message: {user_message[:50]}... (mode: {mode})")
            
            # モードに応じた入力の整形
            if mode == "search":
                user_input = f"/search {user_message}"
            elif mode == "agent":
                user_input = f"/agentmode {user_message}"
            else:
                user_input = user_message
            
            # 処理開始を通知
            await websocket.send_json({
                "type": "status",
                "message": "Processing..."
            })
            
            try:
                # エージェントグラフの実行
                result = await app_state.agent_core.graph.ainvoke({
                    "input": user_input,
                    "chat_history": app_state.chat_history,
                    "agent_scratchpad": [],
                    "messages": [],
                    "agent_outcome": None,
                    "search_query": None,
                    "search_result": None,
                    "order": None,
                    "recalled_episodes": [],
                    "synthesized_memory": None,
                    "generation_logprobs": None,
                })
                
                # チャット履歴を更新
                app_state.chat_history = result.get("chat_history", app_state.chat_history)
                
                # 最後のAIメッセージを取得
                ai_response = ""
                for msg in reversed(app_state.chat_history):
                    if isinstance(msg, AIMessage):
                        ai_response = msg.content
                        break
                
                # 履歴トークン数の管理
                total_tokens = app_state.llm_manager.count_tokens_for_messages(app_state.chat_history)
                if total_tokens > MAX_CHAT_HISTORY_TOKENS:
                    logger.info(f"Chat history exceeds {MAX_CHAT_HISTORY_TOKENS} tokens. Truncating...")
                    
                    # 古いメッセージから削除
                    while total_tokens > MAX_CHAT_HISTORY_TOKENS and len(app_state.chat_history) > 2:
                        removed_msg = app_state.chat_history.pop(0)
                        removed_tokens = app_state.llm_manager.count_tokens_for_messages([removed_msg])
                        total_tokens -= removed_tokens
                    
                    logger.info(f"Truncated to {total_tokens} tokens ({len(app_state.chat_history)} messages)")
                
                # 応答を送信
                await websocket.send_json({
                    "type": "response",
                    "message": ai_response,
                    "mode": mode
                })
                
                # 統計情報を送信
                if app_state.em_llm_integrator and app_state.prof_em_llm_integrator:
                    try:
                        char_stats = app_state.em_llm_integrator.get_memory_statistics()
                        prof_stats = app_state.prof_em_llm_integrator.get_memory_statistics()
                        await websocket.send_json({
                            "type": "stats",
                            "data": {
                                "char_memory": {
                                    "total_events": char_stats.get("total_events", 0)
                                },
                                "prof_memory": {
                                    "total_events": prof_stats.get("total_events", 0)
                                }
                            }
                        })
                    except:
                        pass
                
            except Exception as e:
                logger.error(f"Error processing message: {e}", exc_info=True)
                await websocket.send_json({
                    "type": "error",
                    "message": f"エラーが発生しました: {str(e)}"
                })
    
    except WebSocketDisconnect:
        logger.info("WebSocket connection closed")
    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)


# 静的ファイルの提供（ビルド後のReactアプリ）
# 開発時はReact dev serverを使用するためコメントアウト
# app.mount("/", StaticFiles(directory="frontend/dist", html=True), name="static")

@app.get("/")
async def root():
    """ルートエンドポイント"""
    return {
        "message": "Tepora AI Agent API",
        "version": "1.0.0",
        "docs": "/docs"
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "web_server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
