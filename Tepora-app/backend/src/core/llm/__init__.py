from __future__ import annotations

"""LLM utilities for managing llama.cpp server processes and model access."""

# V1 utilities
from .executable import find_server_executable  # noqa: E402
from .health import perform_health_check_async  # noqa: E402
from .llama_runner import LlamaServerRunner  # noqa: E402
from .ollama_runner import OllamaRunner  # noqa: E402
from .process import build_server_command, launch_server  # noqa: E402

# Runner abstraction (must be imported before runners)
from .runner import LocalModelRunner, RunnerConfig, RunnerStatus, RunnerType  # noqa: E402, I001

# V2 LLM Service
from .service import LLMService  # noqa: E402

__all__ = [
    # V1
    "find_server_executable",
    "perform_health_check_async",
    "build_server_command",
    "launch_server",
    # V2
    "LLMService",
    # Runner abstraction
    "LocalModelRunner",
    "RunnerConfig",
    "RunnerStatus",
    "RunnerType",
    "LlamaServerRunner",
    "OllamaRunner",
]
