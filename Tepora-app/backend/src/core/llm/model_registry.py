import logging
import time
from pathlib import Path
from typing import Dict, Any, Optional

from .. import config
# 循環参照を避けるため、Type hintのみでDownloadManagerを参照したいが
# 実行時にimportできないと困るので、try-exceptでimportする
try:
    from ..download import DownloadManager, ModelRole
    _HAS_DOWNLOAD_MANAGER = True
except ImportError:
    _HAS_DOWNLOAD_MANAGER = False
    DownloadManager = None
    ModelRole = None

logger = logging.getLogger(__name__)

class ModelRegistry:
    """
    モデル設定とファイルパスの解決を担当するクラス。
    """
    def __init__(self, download_manager: Optional["DownloadManager"] = None):
        self._download_manager = download_manager

    def resolve_model_path(self, key: str) -> Path:
        """
        指定キーのモデルファイルパスを解決
        DownloadManager > config.yml の優先順
        """
        # DownloadManagerがあればそちらを優先
        if self._download_manager and ModelRole:
            role_map = {
                "character_model": ModelRole.CHARACTER,
                "executor_model": ModelRole.EXECUTOR,
                "embedding_model": ModelRole.EMBEDDING,
            }
            role = role_map.get(key)
            if role:
                model_path = self._download_manager.get_model_path(role)
                if model_path and model_path.exists():
                    return model_path
        
        # フォールバック: 従来のパス解決
        if key not in config.settings.models_gguf:
             raise ValueError(f"Model key '{key}' not found in configuration.")
             
        model_config = config.settings.models_gguf[key]
        project_root = Path(config.MODEL_BASE_PATH)
        return project_root / model_config.path

    def resolve_binary_path(self, find_executable_func) -> Path | None:
        """
        llama.cpp実行ファイルのパスを解決
        DownloadManager > 従来パス の優先順
        
        Args:
            find_executable_func: 実行ファイル探索関数 (backend.src.core.llm.find_server_executable)
        """
        # DownloadManagerがあればそちらを優先
        if self._download_manager:
            binary_path = self._download_manager.get_binary_path()
            if binary_path and binary_path.exists():
                return binary_path
        
        # フォールバック: 従来のパス解決
        project_root = Path(config.MODEL_BASE_PATH)
        llama_cpp_dir = project_root / "bin" / "llama.cpp"
        return find_executable_func(llama_cpp_dir)

    def resolve_logs_dir(self) -> Path:
        """ログディレクトリを解決"""
        if self._download_manager:
            return self._download_manager.get_logs_dir()
        
        log_dir = config.LOG_DIR
        log_dir.mkdir(exist_ok=True)
        return log_dir

    def get_model_config(self, key: str) -> Any:
        """指定されたキーのモデル設定オブジェクトを返す"""
        if key not in config.settings.models_gguf:
            return None
        return config.settings.models_gguf[key]
