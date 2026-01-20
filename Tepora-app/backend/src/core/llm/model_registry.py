"""
Model Registry - モデル設定の解決

このモジュールは新しい core/models/config.py の ModelConfigResolver への
ラッパーとして機能します。後方互換性のために維持されています。

新しいコードは core.models.ModelConfigResolver を直接使用してください。
"""

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import config

# 新しいモデル管理パッケージを使用
_ModelManager: Any = None
_ModelPool: Any = None
try:
    from ..models import ModelManager as ModelsModelManager
    from ..models import ModelPool as ModelsModelPool

    _ModelManager = ModelsModelManager
    _ModelPool = ModelsModelPool
except ImportError:
    pass

# Compatibility aliases (avoid redefine error from mypy)
ModelManager = _ModelManager
ModelPool = _ModelPool

if TYPE_CHECKING:
    from ..download import DownloadManager as DownloadManagerType
    from ..models import ModelManager as ModelManagerType

logger = logging.getLogger(__name__)


class ModelRegistry:
    """
    モデル設定とファイルパスの解決を担当するクラス。

    ModelManager または DownloadManager と連携して、モデルの実行設定を提供する。
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
        self._download_manager = download_manager
        self._model_manager = model_manager

        # DownloadManager から ModelManager を取得（後方互換）
        if self._download_manager and not self._model_manager:
            self._model_manager = getattr(self._download_manager, "model_manager", None)

    def resolve_model_path(self, key: str, task_type: str = "default") -> Path | None:
        """
        指定キーのモデルファイルパスを解決
        ModelManager > config.yml の優先順

        Args:
            key: モデルキー ("text_model", "embedding_model", "character_model", "executor_model")
            task_type: エグゼキューターモデルのタスクタイプ（executor_modelの場合のみ使用）
        """
        # ModelManager があればそちらを優先
        if self._model_manager and ModelPool:
            if key == "character_model":
                model_path = self._model_manager.get_character_model_path()
                if model_path and model_path.exists():
                    return model_path
                # フォールバック: TEXT プールのアクティブモデル
                model_path = self._model_manager.get_model_path(ModelPool.TEXT)
                if model_path and model_path.exists():
                    return model_path

            elif key == "executor_model":
                model_path = self._model_manager.get_executor_model_path(task_type)
                if model_path and model_path.exists():
                    return model_path
                # フォールバック: TEXT プールのアクティブモデル
                model_path = self._model_manager.get_model_path(ModelPool.TEXT)
                if model_path and model_path.exists():
                    return model_path

            elif key == "text_model":
                model_path = self._model_manager.get_model_path(ModelPool.TEXT)
                if model_path and model_path.exists():
                    return model_path

            elif key == "embedding_model":
                model_path = self._model_manager.get_model_path(ModelPool.EMBEDDING)
                if model_path and model_path.exists():
                    return model_path

        # フォールバック: 従来のパス解決
        resolved_key = key
        if key not in config.settings.models_gguf:
            if key == "character_model" and "text_model" in config.settings.models_gguf:
                resolved_key = "text_model"
            elif key == "text_model" and "character_model" in config.settings.models_gguf:
                resolved_key = "character_model"
            else:
                # ModelManager が存在する場合はエラーをログに記録し、None を返す
                # 呼び出し元でエラーハンドリングを行う
                if self._model_manager:
                    logger.warning(
                        "Model key '%s' not found in config.yml, but ModelManager is available. "
                        "Ensure the model is properly configured in the UI.",
                        key,
                    )
                    return None
                raise ValueError(f"Model key '{key}' not found in configuration.")

        model_config = config.settings.models_gguf[resolved_key]
        project_root = Path(config.MODEL_BASE_PATH)
        return Path(project_root / model_config.path)

    def resolve_binary_path(self, find_executable_func) -> Path | None:
        """
        llama.cpp 実行ファイルのパスを解決
        ModelManager > 従来パス の優先順

        Args:
            find_executable_func: 実行ファイル探索関数
        """
        # ModelManager があればそちらを優先
        if self._model_manager:
            binary_path = self._model_manager.get_binary_path()
            if binary_path and binary_path.exists():
                return binary_path

        # フォールバック: 従来のパス解決
        project_root = Path(config.MODEL_BASE_PATH)
        llama_cpp_dir = project_root / "bin" / "llama.cpp"
        result = find_executable_func(llama_cpp_dir)
        return Path(result) if result else None

    def resolve_logs_dir(self) -> Path:
        """ログディレクトリを解決"""
        if self._model_manager:
            return self._model_manager.get_logs_dir()

        log_dir = config.LOG_DIR
        log_dir.mkdir(exist_ok=True)
        return log_dir

    def get_model_config(self, key: str) -> Any:
        """指定されたキーのモデル設定オブジェクトを返す"""
        # まず config.settings.models_gguf をチェック
        if key in config.settings.models_gguf:
            return config.settings.models_gguf[key]

        # 後方互換フォールバック: text_model <-> character_model
        if key == "text_model":
            if "character_model" in config.settings.models_gguf:
                return config.settings.models_gguf["character_model"]
            if "executor_model" in config.settings.models_gguf:
                return config.settings.models_gguf["executor_model"]
        elif key == "character_model":
            if "text_model" in config.settings.models_gguf:
                return config.settings.models_gguf["text_model"]

        # ModelManager がある場合はデフォルト設定を返す
        if self._model_manager:
            from ..config.schema import ModelGGUFConfig

            default_config = ModelGGUFConfig(
                path="",
                port=0,
                n_ctx=8192,
                n_gpu_layers=-1,
                temperature=0.7,
                top_p=0.9,
                top_k=40,
                repeat_penalty=1.1,
                logprobs=True,
            )
            logger.info("Using default model config for '%s' (managed by ModelManager)", key)
            return default_config

        return None
