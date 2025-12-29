"""
Download Manager - 統合マネージャー

BinaryManagerとModelManagerを統合し、
初回セットアップと要件チェックを提供
"""

import logging
import os
import sys
from pathlib import Path
from typing import List, Optional, Dict

from .binary import BinaryManager
from .models import ModelManager
from .types import (
    DownloadStatus,
    ModelPool,
    ProgressCallback,
    ProgressEvent,
    RequirementsStatus,
    RequirementStatus,
    SetupResult,
)
from src.core.config.loader import settings

logger = logging.getLogger(__name__)


def get_user_data_dir() -> Path:
    """
    ユーザーデータディレクトリを取得
    
    Windows: %LOCALAPPDATA%/Tepora
    macOS: ~/Library/Application Support/Tepora
    Linux: ~/.local/share/tepora
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        return Path(base) / "Tepora"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Tepora"
    else:
        # Linux
        xdg_data = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
        return Path(xdg_data) / "tepora"


class DownloadManager:
    """
    ダウンロード操作の統合マネージャー
    
    - BinaryManager（llama.cpp）とModelManager（GGUF）を統合
    - 初回セットアップ
    - 要件チェック
    """
    
    def __init__(
        self,
        user_data_dir: Optional[Path] = None,
        bundled_fallback: Optional[Path] = None,
    ):
        """
        Args:
            user_data_dir: ユーザーデータディレクトリ (省略時は自動検出)
            bundled_fallback: 同梱CPU版のパス (オプション、省略時は自動検出)
        """
        self.user_data_dir = user_data_dir or get_user_data_dir()
        
        # フォールバックパスの自動検出
        if bundled_fallback is None:
            bundled_fallback = self._detect_bundled_fallback()
        
        self.binary_manager = BinaryManager(
            bin_dir=self.user_data_dir / "bin",
            bundled_fallback=bundled_fallback,
        )
        self.model_manager = ModelManager(
            models_dir=self.user_data_dir / "models",
        )
        self._progress_callbacks: List[ProgressCallback] = []
        
        # サブマネージャーにもコールバックを転送
        self.binary_manager.on_progress(self._forward_progress)
        self.model_manager.on_progress(self._forward_progress)
    
    def _detect_bundled_fallback(self) -> Optional[Path]:
        """
        同梱CPU版のパスを自動検出
        
        Tauriパッケージングされた場合:
          - Windows: 実行ファイルと同じディレクトリに resources/llama-cpu-fallback
          - macOS: .app/Contents/Resources/llama-cpu-fallback
        
        開発環境の場合:
          - frontend/src-tauri/resources/llama-cpu-fallback
        """
        # PyInstallerバンドル時
        if getattr(sys, 'frozen', False):
            # 実行ファイルのディレクトリ
            exe_dir = Path(sys.executable).parent
            
            # Tauriのリソースディレクトリを探す
            candidates = [
                exe_dir / "resources" / "llama-cpu-fallback",
                exe_dir / "llama-cpu-fallback",
                # macOS .app バンドル
                exe_dir.parent / "Resources" / "llama-cpu-fallback",
            ]
            
            for candidate in candidates:
                if candidate.exists():
                    logger.info(f"Found bundled fallback at: {candidate}")
                    return candidate
        
        # 開発環境: プロジェクトルートから探す
        try:
            # このファイルからプロジェクトルートを推定
            # backend/src/core/download/manager.py -> backend -> project_root
            project_root = Path(__file__).resolve().parents[4]
            dev_fallback = project_root / "frontend" / "src-tauri" / "resources" / "llama-cpu-fallback"
            if dev_fallback.exists():
                logger.info(f"Found dev fallback at: {dev_fallback}")
                return dev_fallback
        except Exception as e:
            logger.debug(f"Could not detect dev fallback: {e}")
        
        logger.warning("No bundled fallback found")
        return None
    
    def _forward_progress(self, event: ProgressEvent) -> None:
        """サブマネージャーからの進捗を転送"""
        for callback in self._progress_callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.warning(f"Progress callback error: {e}")
    
    def on_progress(self, callback: ProgressCallback) -> None:
        """進捗コールバックを登録"""
        self._progress_callbacks.append(callback)
    
    def _emit_progress(self, event: ProgressEvent) -> None:
        """進捗イベントを発火"""
        for callback in self._progress_callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.warning(f"Progress callback error: {e}")
    
    async def check_requirements(self) -> RequirementsStatus:
        """
        初回起動時の要件チェック
        
        Returns:
            RequirementsStatus: 各コンポーネントの状態
        """
        # バイナリチェック
        binary_status = RequirementStatus.MISSING
        binary_version = None
        
        if self.binary_manager.is_installed():
            binary_status = RequirementStatus.SATISFIED
            binary_version = await self.binary_manager.get_current_version()
        
        # モデルチェック
        def check_model(pool: ModelPool) -> tuple[RequirementStatus, Optional[str]]:
            model = self.model_manager.get_active_model(pool)
            if model and model.file_path.exists():
                return RequirementStatus.SATISFIED, model.display_name
            return RequirementStatus.MISSING, None
        
        text_status, text_name = check_model(ModelPool.TEXT)
        embed_status, embed_name = check_model(ModelPool.EMBEDDING)
        
        return RequirementsStatus(
            binary_status=binary_status,
            binary_version=binary_version,
            text_model_status=text_status,
            text_model_name=text_name,
            embedding_model_status=embed_status,
            embedding_model_name=embed_name,
        )
    
    async def run_initial_setup(
        self,
        install_binary: bool = True,
        download_default_models: bool = True,
        custom_models: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> SetupResult:
        """
        初回セットアップを実行
        
        Args:
            install_binary: llama.cppバイナリをインストールするか
            download_default_models: デフォルトモデルをダウンロードするか
        """
        errors: List[str] = []
        binary_installed = False
        models_installed: List[str] = []
        
        # 1. バイナリのインストール
        if install_binary:
            self._emit_progress(ProgressEvent(
                status=DownloadStatus.PENDING,
                progress=0.0,
                message="推論エンジンをセットアップ中...",
            ))
            
            result = await self.binary_manager.download_and_install()
            if result.success:
                binary_installed = True
            else:
                # フォールバックを試す
                if self.binary_manager.bundled_fallback:
                    if self.binary_manager.use_fallback():
                        binary_installed = True
                        logger.warning("Using bundled fallback CPU version")
                    else:
                        errors.append(f"Binary installation failed: {result.error_message}")
                else:
                    errors.append(f"Binary installation failed: {result.error_message}")
        
        # 2. デフォルトモデルのダウンロード
        if download_default_models:
            # デフォルトモデルリストを構築（設定ファイルベース）
            # UI等からカスタム設定が渡された場合はそちらを優先
            custom_models = custom_models or {}
            
            # 設定ファイルのデフォルト値を取得
            defaults = settings.default_models
            
            # ターゲットモデルリストを作成
            target_models = []
            
            # Text Model (テキスト生成用LLM)
            text_cfg = custom_models.get("text") or (
                {"repo_id": defaults.character.repo_id, "filename": defaults.character.filename, "display_name": defaults.character.display_name} 
                if defaults.character else None
            )
            if text_cfg:
                target_models.append({
                    "repo_id": text_cfg["repo_id"],
                    "filename": text_cfg["filename"],
                    "pool": ModelPool.TEXT,
                    "display_name": text_cfg.get("display_name", "Text Model"),
                })
                
            # Embedding Model
            embed_cfg = custom_models.get("embedding") or (
                {"repo_id": defaults.embedding.repo_id, "filename": defaults.embedding.filename, "display_name": defaults.embedding.display_name}
                if defaults.embedding else None
            )
            if embed_cfg:
                target_models.append({
                    "repo_id": embed_cfg["repo_id"],
                    "filename": embed_cfg["filename"],
                    "pool": ModelPool.EMBEDDING,
                    "display_name": embed_cfg.get("display_name", "Embedding Model"),
                })

            for model in target_models:
                self._emit_progress(ProgressEvent(
                    status=DownloadStatus.PENDING,
                    progress=0.0,
                    message=f"モデルをダウンロード中: {model['display_name']}",
                ))
                
                result = await self.model_manager.download_from_huggingface(
                    repo_id=model["repo_id"],
                    filename=model["filename"],
                    role=model["pool"],
                    display_name=model["display_name"],
                )
                
                if result.success:
                    models_installed.append(model["display_name"])
                else:
                    errors.append(f"Model download failed ({model['display_name']}): {result.error_message}")
        
        success = len(errors) == 0
        
        self._emit_progress(ProgressEvent(
            status=DownloadStatus.COMPLETED if success else DownloadStatus.FAILED,
            progress=1.0,
            message="セットアップ完了" if success else "セットアップ中にエラーが発生しました",
        ))
        
        return SetupResult(
            success=success,
            binary_installed=binary_installed,
            models_installed=models_installed,
            errors=errors,
        )
    
    def get_binary_path(self) -> Optional[Path]:
        """llama.cpp実行ファイルのパスを取得"""
        return self.binary_manager.get_executable_path()
    
    def get_model_path(self, pool: ModelPool) -> Optional[Path]:
        """指定プールのモデルパスを取得"""
        return self.model_manager.get_model_path(pool)
    
    def get_config_dir(self) -> Path:
        """設定ディレクトリを取得"""
        config_dir = self.user_data_dir / "config"
        config_dir.mkdir(parents=True, exist_ok=True)
        return config_dir
    
    def get_data_dir(self) -> Path:
        """データディレクトリを取得（ChromaDB、SQLiteなど）"""
        data_dir = self.user_data_dir / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir
    
    def get_logs_dir(self) -> Path:
        """ログディレクトリを取得"""
        logs_dir = self.user_data_dir / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        return logs_dir
