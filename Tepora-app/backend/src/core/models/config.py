"""
Model Config Resolver - モデル設定の解決

llama.cpp サーバー起動時に必要なモデル設定を解決する
"""

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from .types import ModelConfig, ModelModality

if TYPE_CHECKING:
    from .manager import ModelManager

logger = logging.getLogger(__name__)


class ModelConfigResolver:
    """
    モデル設定とファイルパスの解決を担当するクラス。

    ModelManager と連携して、モデルの実行設定を提供する。
    config.yml の models_gguf 設定も参照可能（後方互換）。
    """

    def __init__(self, model_manager: "ModelManager | None" = None):
        self._model_manager = model_manager

    def resolve_model_path(self, key: str, task_type: str = "default") -> Path | None:
        """
        指定キーのモデルファイルパスを解決
        """
        if not self._model_manager:
            return self._resolve_from_config(key)

        # ModelManager からパスを解決 (V3)
        if key == "character_model":
            return self._model_manager.get_character_model_path()

        elif key == "executor_model":
            return self._model_manager.get_executor_model_path(task_type)
        
        elif key == "embedding_model":
             # V3 Manager logic: Use embedding role
             mid = self._model_manager.get_assigned_model_id("embedding")
             if mid:
                 m = self._model_manager.get_model(mid)
                 if m and m.path:
                     return Path(m.path)
             return None

        elif key == "text_model":
            # Fallback for generic text model -> use character model
             return self._model_manager.get_character_model_path()

        # フォールバック: config.yml から解決
        return self._resolve_from_config(key)

    def _resolve_from_config(self, key: str) -> Path | None:
        """config.yml からモデルパスを解決（後方互換）"""
        try:
            from ..config import MODEL_BASE_PATH, settings

            resolved_key = key
            if key not in settings.models_gguf:
                # character_model がない場合、text_model をフォールバック
                if key == "character_model" and "text_model" in settings.models_gguf:
                    resolved_key = "text_model"
                elif key == "text_model" and "character_model" in settings.models_gguf:
                    resolved_key = "character_model"
                else:
                    return None

            model_config = settings.models_gguf[resolved_key]
            project_root = Path(MODEL_BASE_PATH)
            return Path(project_root / model_config.path)
        except Exception as e:
            logger.warning("Failed to resolve model path from config: %s", e, exc_info=True)
            return None

    def get_model_config(self, key: str) -> ModelConfig:
        """
        指定されたキーのモデル実行設定を返す

        Args:
            key: モデルキー

        Returns:
            ModelConfig オブジェクト
        """
        # まず config.yml から設定を取得
        config_settings = self._get_config_settings(key)
        if config_settings:
            return ModelConfig(
                n_ctx=getattr(config_settings, "n_ctx", 8192),
                n_gpu_layers=getattr(config_settings, "n_gpu_layers", -1),
                temperature=getattr(config_settings, "temperature", 0.7),
                top_p=getattr(config_settings, "top_p", 0.9),
                top_k=getattr(config_settings, "top_k", 40),
                repeat_penalty=getattr(config_settings, "repeat_penalty", 1.1),
                logprobs=getattr(config_settings, "logprobs", True),
            )

        # デフォルト設定を返す
        logger.info(f"Using default model config for '{key}'")
        return ModelConfig()

    def _get_config_settings(self, key: str):
        """config.yml からモデル設定を取得"""
        try:
            from ..config import settings

            if key in settings.models_gguf:
                return settings.models_gguf[key]

            # フォールバック
            if key == "text_model":
                if "character_model" in settings.models_gguf:
                    return settings.models_gguf["character_model"]
                if "executor_model" in settings.models_gguf:
                    return settings.models_gguf["executor_model"]
            elif key == "character_model":
                if "text_model" in settings.models_gguf:
                    return settings.models_gguf["text_model"]

            return None
        except Exception:
            logger.debug("Failed to read model config from settings", exc_info=True)
            return None

    def resolve_binary_path(self, find_executable_func) -> Path | None:
        """
        llama.cpp 実行ファイルのパスを解決

        Args:
            find_executable_func: 実行ファイル探索関数
        """
        if self._model_manager:
            binary_path = self._model_manager.get_binary_path()
            if binary_path and binary_path.exists():
                return binary_path

        # フォールバック: 従来のパス解決
        try:
            from ..config import MODEL_BASE_PATH

            project_root = Path(MODEL_BASE_PATH)
            llama_cpp_dir = project_root / "bin" / "llama.cpp"
            result = find_executable_func(llama_cpp_dir)
            return Path(result) if result else None
        except Exception as e:
            logger.warning("Failed to resolve binary path: %s", e, exc_info=True)
            return None

    def resolve_logs_dir(self) -> Path:
        """ログディレクトリを解決"""
        if self._model_manager:
            return self._model_manager.get_logs_dir()

        try:
            from ..config import LOG_DIR

            LOG_DIR.mkdir(exist_ok=True)
            return LOG_DIR
        except Exception:
            # 最終フォールバック
            from pathlib import Path

            fallback = Path.cwd() / "logs"
            fallback.mkdir(exist_ok=True)
            return fallback
