from typing import Any

from .agents import *  # noqa: F401, F403
from .app import *  # noqa: F401, F403
from .loader import (
    CHROMA_DB_PATH,
    LOG_DIR,
    MODEL_BASE_PATH,
    PROJECT_ROOT,
    USER_DATA_DIR,
    TeporaSettings,
    config_manager,
    get_user_data_dir,
    is_frozen,
    settings,
)
from .prompts import (
    ACTIVE_PERSONA,
    BASE_SYSTEM_PROMPTS,
    format_tools_for_react_prompt,
    get_persona_prompt_for_profile,
    get_prompt_for_profile,
    resolve_system_prompt,
)
from .schema import (
    AgentProfileConfig,
    AppConfig,
    ChatHistoryConfig,
    EmLLMConfig,
    LLMManagerConfig,
    ModelDownloadAllowlistEntry,
    ModelDownloadConfig,
    ModelGGUFConfig,
    PrivacyConfig,
    ServerConfig,
)

# Lazy loading for config values to prevent import-time side effects
__all__ = [
    "MODELS_GGUF",  # noqa: F405
    "EM_LLM_CONFIG",  # noqa: F405
    "LLAMA_CPP_CONFIG",  # noqa: F405
    "MAX_CHAT_HISTORY_TOKENS",  # noqa: F405
    "DEFAULT_HISTORY_LIMIT",  # noqa: F405
    "TOKENIZER_MODEL_KEY",  # noqa: F405
    "MODEL_BASE_PATH",
    "PROJECT_ROOT",
    "LOG_DIR",
    "USER_DATA_DIR",
    "CHROMA_DB_PATH",
    "get_user_data_dir",
    "is_frozen",
    "config_manager",
    "settings",
    "TeporaSettings",
    # Schema types
    "AgentProfileConfig",
    "AppConfig",
    "ChatHistoryConfig",
    "EmLLMConfig",
    "LLMManagerConfig",
    "ModelDownloadAllowlistEntry",
    "ModelDownloadConfig",
    "ModelGGUFConfig",
    "PrivacyConfig",
    "ServerConfig",
    # Prompts
    "ACTIVE_PERSONA",
    "BASE_SYSTEM_PROMPTS",
    "resolve_system_prompt",
    "format_tools_for_react_prompt",
    "get_persona_prompt_for_profile",
    "get_prompt_for_profile",
]


def __getattr__(name: str) -> Any:
    """Lazy load configuration values."""
    if name == "MODELS_GGUF":
        return settings.models_gguf

    if name == "EM_LLM_CONFIG":
        return settings.em_llm.model_dump()

    if name == "LLAMA_CPP_CONFIG":
        # Provide defaults similar to old runtime.py
        defaults = {
            "health_check_timeout": 30,
            "health_check_interval": 1.0,
            "process_terminate_timeout": 10,
            "embedding_health_check_timeout": 20,
        }
        cfg = settings.llm_manager.model_dump()
        # Merge defaults
        return {**defaults, **cfg}

    if name == "MAX_CHAT_HISTORY_TOKENS":
        return settings.chat_history.max_tokens

    if name == "DEFAULT_HISTORY_LIMIT":
        return settings.chat_history.default_limit

    if name == "TOKENIZER_MODEL_KEY":
        return settings.llm_manager.tokenizer_model_key

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
