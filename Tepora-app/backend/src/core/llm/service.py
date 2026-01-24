"""
LLM Service - Stateless LLM Client Factory

Provides thread-safe, stateless access to LLM models.
Model selection happens per-request, enabling concurrent multi-session usage.

Key differences from V1 LLMManager:
1. No `_current_model_key` state
2. Role-based client retrieval with optional model_id override
3. Factory pattern for client creation
4. Uses LocalModelRunner abstraction for process management (extensible to Ollama etc.)
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx
from langchain_core.embeddings import Embeddings
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage

# Use existing components from core
from src.core.llm.client_factory import ClientFactory
from src.core.llm.executable import find_server_executable
from src.core.llm.llama_runner import LlamaServerRunner
from src.core.llm.model_registry import ModelRegistry
from src.core.llm.runner import LocalModelRunner, RunnerConfig

if TYPE_CHECKING:
    from src.core.download import DownloadManager
    from src.core.models import ModelManager

logger = logging.getLogger(__name__)


@dataclass
class LLMClientConfig:
    """Configuration for an LLM client instance."""

    role: str  # "character", "executor", "embedding"
    model_key: str  # Unique key for caching
    port: int  # Server port
    model_config: Any  # Model configuration object


class LLMService:
    """
    Stateless LLM Service - Factory pattern for model clients.

    This service manages LLM processes and clients without maintaining
    a `_current_model_key` state. Model selection happens per-request,
    enabling concurrent multi-session usage.

    Usage:
        service = LLMService()

        # Get a character model client
        client = await service.get_client("character")
        response = await client.ainvoke(messages)

        # Get an executor model with task type
        executor = await service.get_client("executor", task_type="coding")

    Attributes:
        _registry: Model configuration resolver
        _runner: LocalModelRunner implementation for server lifecycle
        _client_factory: LangChain client factory
    """

    # Default maximum number of cached chat models.
    # Configurable via settings.llm_manager.cache_size (or __init__ override).
    _CACHE_SIZE = 3

    def __init__(
        self,
        download_manager: DownloadManager | None = None,
        model_manager: ModelManager | None = None,
        runner: LocalModelRunner | None = None,
        cache_size: int | None = None,
    ):
        """
        Initialize LLMService.

        Args:
            download_manager: DownloadManager instance (legacy compatibility)
            model_manager: ModelManager instance (preferred)
            runner: LocalModelRunner implementation (default: LlamaServerRunner)
        """
        self._registry = ModelRegistry(
            download_manager=download_manager,
            model_manager=model_manager,
        )
        self._client_factory = ClientFactory()

        # Initialize runner (default to LlamaServerRunner)
        if runner is not None:
            self._runner = runner
        else:
            binary_path = self._registry.resolve_binary_path(find_server_executable)
            logs_dir = self._registry.resolve_logs_dir()
            self._runner = LlamaServerRunner(
                binary_path=binary_path,
                logs_dir=logs_dir,
            )

        # Cache size (default: settings.llm_manager.cache_size, fallback: _CACHE_SIZE)
        try:
            from src.core.config import settings as _settings

            configured_cache_size = getattr(getattr(_settings, "llm_manager", None), "cache_size", None)
        except Exception:  # noqa: BLE001
            configured_cache_size = None

        resolved_cache_size = (
            cache_size if cache_size is not None else (configured_cache_size or self._CACHE_SIZE)
        )
        self._cache_size = max(1, int(resolved_cache_size))

        # Client cache: model_key -> (client, port)
        self._chat_model_cache: dict[str, tuple[BaseChatModel, int]] = {}
        self._embedding_client: tuple[Embeddings, int] | None = None

        # P1-3 修正: モデルキー単位の排他制御用ロック
        self._model_locks: dict[str, asyncio.Lock] = {}
        self._cache_lock = asyncio.Lock()

        logger.info("LLMService initialized (stateless mode with %s)", type(self._runner).__name__)

    def __enter__(self) -> LLMService:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.cleanup()

    async def _count_tokens_via_server(self, text: str, port: int) -> int | None:
        """Count tokens via llama.cpp server /tokenize endpoint."""
        if not text:
            return 0

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"http://127.0.0.1:{port}/tokenize",
                    json={"content": text},
                    timeout=5.0,
                )
            if response.status_code != 200:
                logger.debug(
                    "Tokenize endpoint returned status %s (port=%s)",
                    response.status_code,
                    port,
                )
                return None

            payload = response.json()
            tokens = payload.get("tokens", [])
            if isinstance(tokens, list):
                return len(tokens)
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "Failed to get token count from server (port=%s): %s",
                port,
                exc,
                exc_info=True,
            )
        return None

    async def count_tokens(self, messages: list[BaseMessage]) -> int:
        """
        Count tokens for a list of messages.

        Used by ContextWindowManager for trimming conversation history.
        Falls back to rough estimation if tokenize endpoint is unavailable.
        """
        if not messages:
            return 0

        # Prefer character model port (context trimming is for chat prompts).
        port: int | None = None
        try:
            await self.get_client("character")
        except Exception:
            port = None

        cached = self._chat_model_cache.get("character_model")
        if cached:
            _, port = cached

        total_tokens = 0
        for msg in messages:
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            if not content:
                continue

            if port:
                token_count = await self._count_tokens_via_server(content, port)
                if token_count is not None:
                    total_tokens += token_count
                    continue

            # Fallback estimate: ~4 chars/token
            total_tokens += max(1, len(content) // 4)

        return total_tokens

    async def get_client(
        self,
        role: str,
        *,
        task_type: str = "default",
        model_id: str | None = None,
    ) -> BaseChatModel:
        """
        Get a chat model client for the specified role.

        Args:
            role: Model role ("character", "executor")
            task_type: Task type for executor models
            model_id: Optional model ID override

        Returns:
            BaseChatModel instance ready for inference

        Raises:
            ValueError: If model configuration is invalid
            RuntimeError: If model loading fails
        """
        # Determine model key
        if role == "character":
            model_key = "character_model"
        elif role == "executor":
            model_key = f"executor_model:{task_type}"
        else:
            model_key = role

        # P1-3 修正: モデルキー単位の排他制御でレースコンディションを防止
        async with self._cache_lock:
            if model_key not in self._model_locks:
                self._model_locks[model_key] = asyncio.Lock()
            lock = self._model_locks[model_key]

        async with lock:
            # Check cache (ロック内で再確認)
            if model_key in self._chat_model_cache:
                client, _ = self._chat_model_cache[model_key]
                logger.debug("Returning cached client for '%s'", model_key)
                return client

            # Load model
            client = await self._load_model(model_key, task_type=task_type)
            return client

    async def get_embedding_client(self) -> Embeddings:
        """
        Get embedding model client.

        Returns:
            Embeddings instance for text embedding
        """
        model_key = "embedding_model"

        # P1-3 修正（追加）: embedding_modelも排他制御を適用
        async with self._cache_lock:
            if model_key not in self._model_locks:
                self._model_locks[model_key] = asyncio.Lock()
            lock = self._model_locks[model_key]

        async with lock:
            # Check cache (ロック内で再確認)
            if self._embedding_client is not None:
                client, _ = self._embedding_client
                logger.debug("Returning cached embedding client")
                return client

            # Load embedding model
            model_config = self._registry.get_model_config(model_key)
            if model_config is None:
                raise ValueError("Embedding model configuration not found")

            model_path = self._registry.resolve_model_path(model_key)
            if model_path is None or not model_path.exists():
                raise ValueError(f"Embedding model file not found: {model_path}")

            # Start server via runner
            port = await self._runner.start(
                RunnerConfig(
                    model_key=model_key,
                    model_path=model_path,
                    port=0,  # Auto-assign
                    extra_args=["--embedding"],
                    model_config=model_config,
                )
            )

            # Create client
            client = self._client_factory.create_embedding_client(model_key, port)
            self._embedding_client = (client, port)

            logger.info("Embedding model loaded: %s", model_key)
            return client

    async def _load_model(
        self,
        model_key: str,
        *,
        task_type: str = "default",
    ) -> BaseChatModel:
        """
        Load a chat model and return client.

        Args:
            model_key: Model key (e.g., "character_model", "executor_model:default")
            task_type: Task type for executor models

        Returns:
            BaseChatModel client
        """
        # Parse key for registry lookup
        if model_key.startswith("executor_model:"):
            registry_key = "executor_model"
        else:
            registry_key = model_key

        model_config = self._registry.get_model_config(registry_key)
        if model_config is None:
            raise ValueError(f"Model configuration not found for '{registry_key}'")

        model_path = self._registry.resolve_model_path(registry_key, task_type=task_type)
        if model_path is None or not model_path.exists():
            raise ValueError(f"Model file not found: {model_path}")

        # Evict from cache if full
        if len(self._chat_model_cache) >= self._cache_size:
            await self._evict_oldest_model()

        # Start server via runner
        port = await self._runner.start(
            RunnerConfig(
                model_key=model_key,
                model_path=model_path,
                port=0,  # Auto-assign
                extra_args=[],
                model_config=model_config,
            )
        )

        # Create client
        client = self._client_factory.create_chat_client(model_key, port, model_config)
        self._chat_model_cache[model_key] = (client, port)

        logger.info("Chat model loaded: %s", model_key)
        return client

    async def _evict_oldest_model(self) -> None:
        """Evict the oldest model from cache."""
        if not self._chat_model_cache:
            return

        # Get first key (oldest)
        oldest_key = next(iter(self._chat_model_cache))

        logger.info("Evicting model from cache: %s", oldest_key)

        # Stop process via runner
        await self._runner.stop(oldest_key)

        # Remove from cache
        del self._chat_model_cache[oldest_key]

    def cleanup(self) -> None:
        """
        Clean up all resources.

        Stops all running processes and clears caches.
        """
        logger.info("Cleaning up LLMService...")

        # Stop all processes via runner
        self._runner.cleanup()

        # Clear caches
        self._chat_model_cache.clear()
        self._embedding_client = None

        logger.info("LLMService cleanup complete")

    def get_model_config_for_diagnostics(self, role: str = "character") -> dict[str, Any]:
        """
        Get model configuration for diagnostics.

        Args:
            role: Model role

        Returns:
            Dictionary with model configuration
        """
        if role == "character":
            model_key = "character_model"
        elif role == "executor":
            model_key = "executor_model"
        else:
            model_key = role

        model_config = self._registry.get_model_config(model_key)
        if model_config is None:
            return {"error": f"Model '{model_key}' not configured"}

        return {
            "model_key": model_key,
            "n_ctx": getattr(model_config, "n_ctx", None),
            "n_gpu_layers": getattr(model_config, "n_gpu_layers", None),
            "temperature": getattr(model_config, "temperature", None),
            "cached": model_key in self._chat_model_cache,
        }
