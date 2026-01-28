"""
LLM Service - Stateless LLM Client Factory

Provides thread-safe, stateless access to LLM models.
Model selection happens per-request, enabling concurrent multi-session usage.

Key changes in V3:
1. ID-based model management via ModelManager
2. Support for multiple loaders (llama.cpp, ollama)
3. Removed legacy ModelRegistry class usage
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from langchain_core.embeddings import Embeddings
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage

# Use existing components from core
from src.core.llm.client_factory import ClientFactory
from src.core.llm.executable import find_server_executable
from src.core.llm.llama_runner import LlamaServerRunner
from src.core.llm.ollama_runner import OllamaRunner
from src.core.llm.runner import LocalModelRunner, RunnerConfig
from src.core.models.config import ModelConfigResolver
from src.core.models.types import ModelInfo, ModelLoader

if TYPE_CHECKING:
    from src.core.download import DownloadManager
    from src.core.models import ModelManager

logger = logging.getLogger(__name__)


class LLMService:
    """
    Stateless LLM Service - Factory pattern for model clients.

    Manages LLM processes (llama.cpp or Ollama) and clients without maintaining
    global state. Model selection happens per-request.
    """

    _CACHE_SIZE = 3

    def __init__(
        self,
        download_manager: DownloadManager | None = None,  # Legacy compatibility
        model_manager: ModelManager | None = None,
        runner: LocalModelRunner | None = None,  # Optional override for testing
        cache_size: int | None = None,
    ):
        """
        Initialize LLMService.
        """
        # We generally expect model_manager to be provided in V3
        self._model_manager = model_manager

        # Config resolver for backward compatibility or extra configs
        self._config_resolver = ModelConfigResolver(model_manager)

        self._client_factory = ClientFactory()

        # Runners
        # If a generic runner is passed (testing), we use it for both?
        # For production, we instantiate specific runners.
        if runner:
            # Test mode usually
            self._llama_runner = runner
            self._ollama_runner = runner  # Mock or same runner
            self._is_test_runner = True
        else:
            # Llama.cpp Runner
            binary_path = None
            logs_dir = None
            if self._model_manager:
                binary_path = self._model_manager.get_binary_path()
                logs_dir = self._model_manager.get_logs_dir()

            if not binary_path:
                # Fallback?
                from pathlib import Path

                from src.core.config import MODEL_BASE_PATH

                binary_path = find_server_executable(Path(MODEL_BASE_PATH) / "bin" / "llama.cpp")

            if not logs_dir:
                from pathlib import Path

                logs_dir = Path.cwd() / "logs"

            self._llama_runner = LlamaServerRunner(binary_path=binary_path, logs_dir=logs_dir)
            self._ollama_runner = OllamaRunner()  # Assumes default localhost:11434 config
            self._is_test_runner = False

        # Cache configuration
        try:
            from src.core.config import settings as _settings

            configured_cache_size = getattr(
                getattr(_settings, "llm_manager", None), "cache_size", None
            )
        except Exception:
            configured_cache_size = None

        resolved_cache_size = (
            cache_size if cache_size is not None else (configured_cache_size or self._CACHE_SIZE)
        )
        self._cache_size = max(1, int(resolved_cache_size))

        # Client cache: model_id -> client
        self._chat_model_cache: dict[str, BaseChatModel] = {}
        self._embedding_client: Embeddings | None = None
        self._current_embedding_model_id: str | None = None
        self._current_embedding_runner_key: str | None = None

        # Locks
        self._model_locks: dict[str, asyncio.Lock] = {}
        self._cache_lock = asyncio.Lock()
        self._embedding_lock = asyncio.Lock()

        logger.info("LLMService initialized")

    def __enter__(self) -> LLMService:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.cleanup()

    def _get_runner(self, loader: ModelLoader):
        if self._is_test_runner:
            return self._llama_runner
        if loader == ModelLoader.OLLAMA:
            return self._ollama_runner
        return self._llama_runner

    async def count_tokens(self, messages: list[BaseMessage]) -> int:
        """
        Count tokens for a list of messages.
        Uses the character model (primary execution model) for counting.
        """
        if not messages:
            return 0

        # Resolve character model
        model_id = None
        if self._model_manager:
            model_id = self._model_manager.get_assigned_model_id("character")

        # If no model managed, we can't count reliably?
        # Fallback to a default if testing
        if not model_id and not self._is_test_runner:
            logger.warning("No character model assigned for token counting.")
            return 0

        total_tokens = 0

        # We need the model info to know the loader
        if not self._model_manager:
            return 0
        model = self._model_manager.get_model(model_id) if model_id else None
        if not model and not self._is_test_runner:
            return 0

        # Mock logic compatibility: if test runner, allow missing model
        runner = self._get_runner(model.loader if model else ModelLoader.LLAMA_CPP)

        # key for runner
        key = model_id if model_id else "character_model"
        if model and model.loader == ModelLoader.OLLAMA and model.path:
            key = model.path

        for msg in messages:
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            if not content:
                continue

            count = await runner.count_tokens(content, key)
            total_tokens += count

        return total_tokens

    async def get_client(
        self,
        role: str,
        *,
        task_type: str = "default",
        model_id: str | None = None,
    ) -> BaseChatModel:
        """
        Get a chat model client.

        Args:
            role: Model role ("character", "executor") - USED ONLY IF model_id IS NONE
            task_type: Task type for executor role
            model_id: Specific model ID to load (overrides role lookup)
        """
        # 1. Resolve Model ID
        target_model_id = model_id

        if not target_model_id:
            # Resolve from role via Manager
            if not self._model_manager:
                raise RuntimeError("ModelManager not available to resolve role")

            lookup_key = role
            if role == "executor":
                lookup_key = f"executor:{task_type}" if task_type != "default" else "executor"

            target_model_id = self._model_manager.get_assigned_model_id(lookup_key)
            if not target_model_id and role == "executor" and task_type != "default":
                # Fallback to default executor
                target_model_id = self._model_manager.get_assigned_model_id("executor")

            if not target_model_id:
                # Legacy fallback for tests or bad config?
                # If role is character, maybe we have a model?
                # For V3 strictness, we should fail or return a helpful error.
                raise ValueError(f"No model assigned for role '{role}' (task: {task_type})")

        # 2. Get Model Info
        if not self._model_manager:
            raise RuntimeError("ModelManager not available")
        model_info = self._model_manager.get_model(target_model_id)
        if not model_info:
            raise ValueError(f"Model ID '{target_model_id}' not found in registry")

        # 3. Cache / Lock
        async with self._cache_lock:
            if target_model_id not in self._model_locks:
                self._model_locks[target_model_id] = asyncio.Lock()
            lock = self._model_locks[target_model_id]

        async with lock:
            if target_model_id in self._chat_model_cache:
                client = self._chat_model_cache[target_model_id]
                return client

            # Load
            client = await self._load_model(model_info)
            return client

    async def get_embedding_client(self) -> Embeddings:
        """Get embedding model client."""
        # Resolve ID
        target_model_id = None
        if self._model_manager:
            target_model_id = self._model_manager.get_assigned_model_id("embedding")

        if not target_model_id:
            raise ValueError("No embedding model assigned")

        async with self._embedding_lock:
            # Re-check within the lock in case another task initialized it.
            if self._embedding_client and self._current_embedding_model_id == target_model_id:
                return self._embedding_client

            if not self._model_manager:
                raise RuntimeError("ModelManager not available")

            model_info = self._model_manager.get_model(target_model_id)
            if not model_info:
                raise ValueError(f"Embedding model {target_model_id} not found")

            previous_model_id = self._current_embedding_model_id
            previous_runner_key = self._current_embedding_runner_key

            runner = self._get_runner(model_info.loader)
            runner_key = model_info.id
            if model_info.loader == ModelLoader.OLLAMA and model_info.path:
                runner_key = model_info.path

            # Start
            port = await runner.start(
                RunnerConfig(
                    model_key=runner_key,
                    model_path=Path(model_info.path)
                    if model_info.loader == ModelLoader.LLAMA_CPP
                    else None,
                    port=0,
                    extra_args=["--embedding"]
                    if model_info.loader == ModelLoader.LLAMA_CPP
                    else [],  # Ollama doesn't need --embedding flag usually?
                    model_config=model_info.config,
                )
            )

            base_url = runner.get_base_url(runner_key) or f"http://localhost:{port}"

            model_key = model_info.id
            if model_info.loader == ModelLoader.OLLAMA and model_info.path:
                model_key = model_info.path

            client = self._client_factory.create_embedding_client(model_key, base_url)
            self._embedding_client = client
            self._current_embedding_model_id = target_model_id
            self._current_embedding_runner_key = runner_key

            if previous_model_id and previous_model_id != target_model_id and previous_runner_key:
                if self._model_manager:
                    previous_model = self._model_manager.get_model(previous_model_id)
                else:
                    previous_model = None
                if previous_model:
                    previous_runner = self._get_runner(previous_model.loader)
                    await previous_runner.stop(previous_runner_key)

            logger.info("Embedding model loaded: %s", target_model_id)
            return client

    async def _load_model(self, model_info: ModelInfo) -> BaseChatModel:
        """Internal load logic"""

        # Evict if full
        if len(self._chat_model_cache) >= self._cache_size:
            await self._evict_oldest_model()

        runner = self._get_runner(model_info.loader)

        # Determine Path (For Llama.cpp) or Tag (Ollama)
        path = None
        if model_info.loader == ModelLoader.LLAMA_CPP:
            from pathlib import Path

            path = Path(model_info.path)
            if not path.exists():
                raise ValueError(f"Model file not found: {path}")

        # Start Server
        # NOTE: Ollama runner config expects model_key to be the TAG name?
        # My OllieRunner says: `model_name = config.model_key` and expects it to be the tag.
        # But `model_info.id` is a uuid. `model_info.path` holds the TAG for ollama (from my types.py plan).
        # "path: str # File path or Ollama tag"

        # So:
        # If llama_cpp: key=id, path=path
        # If ollama: key=path(tag), path=None?
        # Wait, if I use key=tag, then multiple services using same tag might collide if I track by key?
        # LLMService tracks by `model_id` (UUID).
        # Runner tracks by `model_key`.
        # OllamaRunner tracks by `model_key` which it assumes is the model name.

        runner_key = model_info.id
        if model_info.loader == ModelLoader.OLLAMA:
            runner_key = model_info.path  # Use the tag name for Ollama runner

        port = await runner.start(
            RunnerConfig(
                model_key=runner_key,
                model_path=path,
                port=0,
                extra_args=model_info.config.extra_args,
                model_config=model_info.config,
            )
        )

        base_url = runner.get_base_url(runner_key) or f"http://localhost:{port}"

        client_model_key = model_info.id
        if model_info.loader == ModelLoader.OLLAMA and model_info.path:
            client_model_key = model_info.path

        client = self._client_factory.create_chat_client(
            client_model_key, base_url, model_info.config
        )
        self._chat_model_cache[model_info.id] = client
        logger.info("Chat model loaded: %s via %s", model_info.id, model_info.loader)
        return client

    async def _evict_oldest_model(self) -> None:
        if not self._chat_model_cache:
            return

        oldest_id = next(iter(self._chat_model_cache))
        logger.info("Evicting model: %s", oldest_id)

        # Stop via proper runner
        # Need to know which runner owns this ID?
        # We can look up in ModelManager
        if self._model_manager:
            model = self._model_manager.get_model(oldest_id)
            if model:
                runner = self._get_runner(model.loader)
                # Need to use same key used for start
                key = oldest_id
                if model.loader == ModelLoader.OLLAMA:
                    key = model.path
                await runner.stop(key)

        del self._chat_model_cache[oldest_id]

    def cleanup(self) -> None:
        logger.info("Cleaning up LLMService...")
        self._llama_runner.cleanup()
        self._ollama_runner.cleanup()
        self._chat_model_cache.clear()
        self._embedding_client = None
        self._current_embedding_model_id = None
        self._current_embedding_runner_key = None
        logger.info("Cleanup complete")

    def get_model_config_for_diagnostics(self, role: str = "character") -> dict[str, Any]:
        """Diagnostic info"""
        if not self._model_manager:
            return {"error": "No manager"}

        mid = self._model_manager.get_assigned_model_id(role)
        if not mid:
            # Try direct ID?
            mid = self._model_manager.get_assigned_model_id(f"executor:{role}") or role

        model = self._model_manager.get_model(mid)
        if not model:
            return {"error": f"Model not found for {role}"}

        return {
            "model_id": model.id,
            "name": model.name,
            "loader": model.loader,
            "path": model.path,
            "cached": model.id in self._chat_model_cache,
        }
