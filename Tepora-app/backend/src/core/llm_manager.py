import asyncio
import gc
import logging
import re
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

# オプショナルな依存
from typing import Any as _Any

import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage

from . import config
from .llm import build_server_command, find_server_executable
from .llm.client_factory import ClientFactory
from .llm.model_registry import ModelRegistry
from .llm.process_manager import ProcessManager

_DownloadManager: _Any = None
_ModelManager: _Any = None

try:
    from .download import DownloadManager as ModelsDownloadManager

    _DownloadManager = ModelsDownloadManager
except ImportError:
    pass

try:
    from .models import ModelManager as CoreModelManager

    _ModelManager = CoreModelManager
except ImportError:
    pass

if TYPE_CHECKING:
    from .download import DownloadManager as DownloadManagerType
    from .models import ModelManager as ModelManagerType

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _ServerLaunch:
    command: list[str]
    port: int
    stderr_log_path: Path


class LLMManager:
    """
    GGUFモデルをLlama.cppで動的にロード・アンロードするためのマネージャークラス。

    責務を分割したコンポーネント(ModelRegistry, ProcessManager, ClientFactory)を統括する。
    """

    def __init__(
        self,
        download_manager: "DownloadManagerType | None" = None,
        model_manager: "ModelManagerType | None" = None,
    ):
        """
        Args:
            download_manager: DownloadManager インスタンス (後方互換用)
            model_manager: ModelManager インスタンス (推奨)
        """
        self._model_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._current_model_key: str | None = None

        # ModelManager を取得（直接渡された場合、または DownloadManager 経由）
        self._model_manager: ModelManagerType | None
        if model_manager:
            self._model_manager = model_manager
        elif download_manager:
            self._model_manager = getattr(download_manager, "model_manager", None)
        else:
            self._model_manager = None

        # Components
        self.registry = ModelRegistry(
            download_manager=download_manager,
            model_manager=self._model_manager,
        )
        self.process_manager = ProcessManager()
        self.client_factory = ClientFactory()

        # Model cache: key -> (llm_instance, model_config, port)
        self._chat_model_cache: dict[str, tuple] = {}
        self._cache_size = config.settings.llm_manager.cache_size

        # Embedding model (persisted separately)
        self._embedding_llm = None

        logger.info("LLMManager for Llama.cpp initialized.")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.cleanup()

    def _prepare_server_launch(
        self,
        *,
        key: str,
        model_path: Path,
        model_config: Any,
        extra_args: list[str] | None = None,
    ) -> _ServerLaunch:
        server_executable = self.registry.resolve_binary_path(find_server_executable)
        if not model_path.exists():
            raise FileNotFoundError(f"Model file not found at: {model_path}")
        if not server_executable:
            raise FileNotFoundError("llama.cpp server executable not found.")

        log_dir = self.registry.resolve_logs_dir()
        safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", key)
        stderr_log_path = log_dir / f"llama_server_{safe_key}_{int(time.time())}.log"
        port = self.process_manager.find_free_port()

        command = build_server_command(
            server_executable,
            model_path,
            port=port,
            n_ctx=model_config.n_ctx,
            n_gpu_layers=model_config.n_gpu_layers,
            extra_args=extra_args or [],
        )

        return _ServerLaunch(command=command, port=port, stderr_log_path=stderr_log_path)

    async def _start_server(self, key: str, launch: _ServerLaunch) -> None:
        try:
            self.process_manager.start_process(key, launch.command, launch.stderr_log_path)
            await self.process_manager.perform_health_check_async(
                launch.port, key, launch.stderr_log_path
            )
        except Exception as exc:
            logger.error("Failed to start server for '%s': %s", key, exc, exc_info=True)
            self.process_manager.stop_process(key)
            raise

    def _evict_from_cache(self, key: str):
        """Evict a specific model from the cache and terminate its process."""
        if key in self._chat_model_cache:
            logger.info("Evicting model '%s' from cache.", key)
            del self._chat_model_cache[key]

            # Stop the process via ProcessManager
            self.process_manager.stop_process(key)

        if self._current_model_key == key:
            self._current_model_key = None

        gc.collect()  # メモリを明示的に解放

    def _unload_embedding_model(self):
        """埋め込みモデルを解放する。"""
        if self._embedding_llm:
            logger.info("Unloading embedding model...")
            self._embedding_llm = None
            key = "embedding_model"
            self.process_manager.stop_process(key)

    async def _load_model(self, key: str):
        """指定された対話用GGUFモデルをLlama.cppでロードする。"""
        async with self._model_locks[key]:
            if self._current_model_key == key:
                return

            # --- Cache Check ---
            if key in self._chat_model_cache:
                logger.info("Model '%s' found in cache. Activating.", key)
                self._current_model_key = key
                return

            # --- Cache Eviction ---
            if len(self._chat_model_cache) >= self._cache_size:
                # Simple LRU: evict the one that is not the current one (if any)
                key_to_evict = next(iter(self._chat_model_cache.keys()))
                self._evict_from_cache(key_to_evict)

            # --- 情報取得 ---
            model_config = self.registry.get_model_config(key)
            if not model_config:
                raise ValueError(f"Model configuration for '{key}' not found.")

            model_path = self.registry.resolve_model_path(key)
            if not model_path:
                raise ValueError(
                    f"Model path for '{key}' could not be resolved. "
                    "Please configure a model in the setup wizard."
                )
            launch = self._prepare_server_launch(
                key=key,
                model_path=model_path,
                model_config=model_config,
            )
            logger.info("Allocated dynamic port %d for model '%s'", launch.port, key)

            # --- 起動 & ヘルスチェック ---
            await self._start_server(key, launch)

            # --- クライアント作成 ---
            chat_llm = self.client_factory.create_chat_client(key, launch.port, model_config)

            # Cache: (llm, config, port)
            self._chat_model_cache[key] = (chat_llm, model_config, launch.port)
            self._current_model_key = key

            logger.info("LLM client for '%s' ready.", key)

    async def get_embedding_model(self):
        """埋め込みモデルを取得またはロードする。"""
        if self._embedding_llm is None:
            async with self._model_locks["embedding_model"]:
                if self._embedding_llm is None:
                    key = "embedding_model"

                    model_config = self.registry.get_model_config(key)
                    model_path = self.registry.resolve_model_path(key)
                    launch = self._prepare_server_launch(
                        key=key,
                        model_path=model_path,
                        model_config=model_config,
                        extra_args=["--embedding"],
                    )
                    logger.info("Allocated port %d for embedding model", launch.port)

                    await self._start_server(key, launch)

                    self._embedding_llm = self.client_factory.create_embedding_client(
                        key, launch.port
                    )

        return self._embedding_llm

    def get_current_model_config_for_diagnostics(self) -> dict:
        """
        診断用に、現在ロードされているメインのChatLLMモデルの設定を返す。
        """
        if self._current_model_key and self._current_model_key in self._chat_model_cache:
            _llm, config_data, _port = self._chat_model_cache[self._current_model_key]

            if hasattr(config_data, "model_dump"):
                config_copy = config_data.model_dump()
            elif isinstance(config_data, dict):
                config_copy = config_data.copy()
            else:
                # Try object to dict
                try:
                    config_copy = config_data.__dict__.copy()
                except AttributeError:
                    config_copy = str(config_data)

            # Ensure it is a dict
            if not isinstance(config_copy, dict):
                config_copy = {"raw_config": str(config_copy)}

            config_copy["key"] = self._current_model_key
            config_copy["streaming"] = True
            return config_copy
        return {}

    def _get_active_chat_model(self) -> BaseChatModel | None:
        if self._current_model_key and self._current_model_key in self._chat_model_cache:
            return self._chat_model_cache[self._current_model_key][0]
        return None

    async def get_text_model(self) -> BaseChatModel:
        """テキスト生成モデル（後方互換）。get_character_model()を推奨。"""
        return await self.get_character_model()

    async def get_character_model(self) -> BaseChatModel:
        """キャラクターモデル（会話用）を取得する。"""
        await self._load_model("character_model")
        return self._get_active_chat_model()

    async def get_executor_model(self, task_type: str = "default") -> BaseChatModel:
        """
        エグゼキューターモデル（ツール実行用）を取得する。

        Args:
            task_type: タスクタイプ (e.g., "default", "coding", "browser")
        """
        # executor_model用のカスタムロード（task_type対応）
        key = f"executor_model:{task_type}"
        async with self._model_locks[key]:
            # 既にロード済みの場合
            if key in self._chat_model_cache:
                self._current_model_key = key
                return self._chat_model_cache[key][0]

            # キャッシュのエビクション
            if len(self._chat_model_cache) >= self._cache_size:
                key_to_evict = next(iter(self._chat_model_cache.keys()))
                self._evict_from_cache(key_to_evict)

            # モデル設定を取得（text_modelの設定を流用）
            model_config = self.registry.get_model_config("text_model")
            if not model_config:
                raise ValueError("Model configuration for executor not found.")

            # タスクタイプ対応のパス解決
            model_path = self.registry.resolve_model_path("executor_model", task_type)
            if not model_path:
                raise ValueError(
                    f"Model path for 'executor_model' (task_type: {task_type}) could not be resolved. "
                    "Please configure a model in the setup wizard."
                )
            launch = self._prepare_server_launch(
                key=key,
                model_path=model_path,
                model_config=model_config,
            )
            logger.info(
                "Allocated port %d for executor model (task_type: %s)",
                launch.port,
                task_type,
            )

            await self._start_server(key, launch)

            chat_llm = self.client_factory.create_chat_client(key, launch.port, model_config)
            self._chat_model_cache[key] = (chat_llm, model_config, launch.port)
            self._current_model_key = key

            logger.info("Executor model for '%s' ready.", task_type)
            return chat_llm

    # 後方互換エイリアス（非推奨、将来削除予定）
    async def get_executor_agent_model(self) -> BaseChatModel:
        """[非推奨] get_executor_model()を使用してください"""
        return await self.get_executor_model("default")

    def cleanup(self):
        """アプリケーション終了時にリソースを解放する"""
        logger.info("Cleaning up LLMManager...")
        # Clear main cache
        self._chat_model_cache.clear()
        self._current_model_key = None
        self._unload_embedding_model()

        # Delegate process cleanup to ProcessManager
        self.process_manager.cleanup()

        gc.collect()

    async def _count_tokens_via_server(self, text: str, port: int) -> int | None:
        """llama.cpp サーバーの /tokenize エンドポイントを使用してトークン数を取得する。(非同期)"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"http://localhost:{port}/tokenize", json={"content": text}, timeout=5.0
                )
                if response.status_code == 200:
                    tokens = response.json().get("tokens", [])
                    return len(tokens)
                else:
                    logger.warning(
                        "Tokenize endpoint returned status %s (port=%s)",
                        response.status_code,
                        port,
                    )
                    return None
        except Exception as e:
            logger.warning(
                "Failed to get token count from server (port=%s): %s",
                port,
                e,
                exc_info=True,
            )
            return None

    async def count_tokens_for_messages(self, messages: list[BaseMessage]) -> int:
        """メッセージリストの合計トークン数を数える"""
        if not messages:
            return 0

        # Get port from cache
        port = None
        if self._current_model_key and self._current_model_key in self._chat_model_cache:
            # Cache is now: (llm, config, port)
            _, _, port = self._chat_model_cache[self._current_model_key]

        total_tokens = 0
        for msg in messages:
            if not isinstance(msg.content, str):
                continue

            if port:
                token_count = await self._count_tokens_via_server(msg.content, port)
                if token_count is not None:
                    total_tokens += token_count
                    continue

            # Fallback
            total_tokens += len(msg.content) // 2

        return total_tokens
