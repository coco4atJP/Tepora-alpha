"""
OllamaRunner - Runner implementation for Ollama API.

This module provides the integration with the Ollama API, processing model management
and inference requests via HTTP.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .runner import RunnerConfig, RunnerStatus

__all__ = ["OllamaRunner"]

logger = logging.getLogger(__name__)


class OllamaRunner:
    """
    Runner for managing models via Ollama API.

    Features:
    - Connects to external Ollama service (default: localhost:11434)
    - Verifies model availability on start
    - Manages model unloading via 'keep_alive' parameter
    - Provides tokenization support using Ollama's /api/tokenize

    Attributes:
        _base_url: Base URL for Ollama API
        _running_models: Set of currently "active" models (logically)
    """

    DEFAULT_BASE_URL = "http://localhost:11434"
    DEFAULT_API_PORT = 11434

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        """
        Initialize OllamaRunner.

        Args:
            base_url: Base URL for Ollama API
        """
        self._base_url = base_url.rstrip("/")
        # In Ollama, models are always "running" if the service is up,
        # but we track what we've "started" (verified/loaded) for API consistency.
        self._running_models: set[str] = set()

        logger.info("OllamaRunner initialized (base_url=%s)", self._base_url)

    async def _check_connection(self) -> bool:
        """Check if Ollama service is reachable."""
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(self._base_url)
                return bool(response.status_code == 200)
        except Exception as e:
            logger.debug("Ollama connection check failed: %s", e)
            return False

    async def _list_models(self) -> list[str]:
        """Fetch list of available models from Ollama."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self._base_url}/api/tags")
                if response.status_code != 200:
                    logger.warning("Failed to list models: %s", response.text)
                    return []

                data = response.json()
                if not isinstance(data, dict):
                    return []

                models = data.get("models", [])
                if not isinstance(models, list):
                    return []

                return [
                    str(model["name"])
                    for model in models
                    if isinstance(model, dict) and "name" in model
                ]
        except Exception as e:
            logger.error("Error listing models: %s", e)
            return []

    async def start(self, config: RunnerConfig) -> int:
        """
        Start (verify) a model on Ollama.

        Since Ollama manages processes internally, this method primarily:
        1. Checks connectivity to Ollama
        2. Verifies the requested model exists (pulling is not yet implemented)
        3. Marks the model as "running"

        Args:
            config: Runner configuration
                config.model_key is treated as the Ollama Model Name (e.g. "llama3").

        Returns:
            Ollama API port (11434)

        Raises:
            RuntimeError: If Ollama is not reachable.
        """
        # Check connectivity
        if not await self._check_connection():
            raise RuntimeError(f"Cannot connect to Ollama at {self._base_url}. Is it running?")

        model_name = config.model_key

        # Check model existence
        # Note: We match loosely because "llama3" might match "llama3:latest"
        available_models = await self._list_models()
        if model_name not in available_models and f"{model_name}:latest" not in available_models:
            # Try exact match or match with latest tag.
            # If strictly not found, warn and proceed (Ollama may auto-pull if configured).
            logger.warning(
                "Model '%s' not found in Ollama list (%s). Attempting to proceed (Ollama might auto-pull if configured)...",
                model_name,
                available_models,
            )
            # In future: trigger pull here if missing

        # "Start" (Mark as active)
        # We can optionally trigger a simple preload here via /api/generate with empty prompt?
        # For now, just mark it.
        self._running_models.add(model_name)
        logger.info("OllamaRunner: Model '%s' ready", model_name)

        # Pre-load model into VRAM (Optional but recommended)
        # We send an empty request to force load.
        # Note: /api/chat with keep_alive triggers load without generating if we just want to load.
        # But simply sending a request is enough.
        try:
            # Using 0 keep_alive to just load and unload? No, we want to KEEP it loaded.
            # Default keep_alive is usually 5m.
            await self._preload_model(model_name)
        except Exception as e:
            logger.warning("Failed to preload model '%s': %s", model_name, e)

        return self.DEFAULT_API_PORT

    async def _preload_model(self, model_key: str) -> None:
        """Send a dummy request to force model loading."""
        # We don't actually need to generate. A short /api/generate call is enough
        # to hint Ollama to load the model into memory.
        async with httpx.AsyncClient(timeout=1.0) as client:
            # Just fire a request, ignore result (it might error on empty prompt but load model)
            # Actually, newer Ollama versions load on request.
            # Sending `{"model": option}` to /api/generate triggers load?
            try:
                await client.post(
                    f"{self._base_url}/api/generate", json={"model": model_key}, timeout=0.1
                )
            except httpx.TimeoutException:
                pass  # Expected, we don't wait for generation
            except Exception as e:
                logger.debug("Ollama preload request failed (ignorable): %s", e)

    async def count_tokens(self, text: str, model_key: str) -> int:
        """Count tokens via Ollama /api/tokenize."""
        if not text:
            return 0

        tokens = await self.tokenize(text, model_key)
        return len(tokens)

    def get_base_url(self, model_key: str) -> str | None:
        """Get Ollama base URL."""
        # Ollama is a single service, so base_url is same for all models.
        # However, it might be remote.
        return self._base_url

    async def get_capabilities(self, model_key: str) -> dict[str, Any]:
        """
        Get model capabilities via /api/show.

        Returns:
            dict with 'vision', 'tools', etc.
        """
        url = f"{self._base_url}/api/show"
        payload = {"name": model_key}

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(url, json=payload)
                if response.status_code != 200:
                    return {}

                data = response.json()
                # data['details']['families'] might contain 'clip' or 'vision' for vision models?
                # or 'model_info' might have architecture.
                # data['model_info'] -> { ... 'general.architecture': 'llama' ... }

                # Check for vision
                details = data.get("details", {})
                families = details.get("families", [])

                # Heuristic: families contains "clip" or "mllama" or similar?
                # LLaVA models usually include "clip" in families or separate projector.
                # Using broad heuristics.
                is_vision = (
                    "clip" in families or "mllama" in families or "vision" in str(families).lower()
                )

                # Check for tools? Ollama supports tools for some models.
                # Currently tricky to detect via API, but we can assume false or check template?
                template = data.get("template", "")

                return {
                    "vision": is_vision,
                    "chat_template": template,
                    "model_path": None,  # Ollama manages paths internally
                    "raw_show": data,
                }
        except Exception as e:
            logger.warning("Failed to get capabilities for '%s': %s", model_key, e)
            return {}

    async def stop(self, model_key: str) -> None:
        """
        Unload model from memory.

        Sends a keep_alive=0 request to Ollama to free VRAM.

        Args:
            model_key: Ollama Model Name
        """
        if model_key not in self._running_models:
            return

        url = f"{self._base_url}/api/chat"
        payload = {"model": model_key, "keep_alive": 0}

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                # Fire and forget / check status
                await client.post(url, json=payload)
                logger.info("OllamaRunner: Unloaded model '%s'", model_key)
        except Exception as e:
            logger.warning("Failed to unload model '%s': %s", model_key, e)
        finally:
            self._running_models.discard(model_key)

    def is_running(self, model_key: str) -> bool:
        """Check if we consider this model 'started'."""
        return model_key in self._running_models

    def get_port(self, model_key: str) -> int | None:
        """Get Ollama API port."""
        if not self.is_running(model_key):
            return None
        return self.DEFAULT_API_PORT

    def get_status(self, model_key: str) -> RunnerStatus:
        """Get status of the runner/model."""
        if not self.is_running(model_key):
            return RunnerStatus(is_running=False)

        # We could query /api/ps here for real memory status
        return RunnerStatus(
            is_running=True,
            port=self.DEFAULT_API_PORT,
        )

    async def tokenize(self, text: str, model_key: str) -> list[int]:
        """
        Tokenize text using Ollama /api/tokenize.

        Args:
            text: Text to tokenize
            model_key: Ollama Model Name

        Returns:
            List of token IDs
        """
        url = f"{self._base_url}/api/tokenize"
        payload = {"model": model_key, "prompt": text}

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(url, json=payload)
                if response.status_code == 200:
                    data = response.json()
                    if isinstance(data, dict):
                        tokens = data.get("tokens", [])
                        if isinstance(tokens, list):
                            return [int(t) for t in tokens if isinstance(t, int)]
                else:
                    logger.warning("Tokenize failed: %s", response.text)
        except Exception as e:
            logger.error("Error tokenizing text: %s", e)

        return []

    def cleanup(self) -> None:
        """Cleanup - just clear local tracking."""
        self._running_models.clear()
