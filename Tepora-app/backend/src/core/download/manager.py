"""
Download Manager - 統合マネージャー

BinaryManagerとModelManagerを統合し、
初回セットアップと要件チェックを提供
"""

import logging
import os
import sys
from pathlib import Path
from typing import Any

from src.core.config.loader import settings

# 新しいcore/modelsパッケージからModelManagerをインポート
from ..models import ModelManager
from ..models.types import ModelPool as ModelsModelPool
from ..models.types import ProgressEvent as ModelsProgressEvent
from .binary import BinaryManager
from .types import (
    DownloadStatus,
    ModelPool,
    ProgressCallback,
    ProgressEvent,
    RequirementsStatus,
    RequirementStatus,
    SetupResult,
)

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


def _normalize_model_pool(role: Any) -> ModelPool | None:
    if isinstance(role, ModelPool):
        return role

    if role is None:
        return None

    role_value = str(role).lower()
    try:
        return ModelPool(role_value)
    except ValueError:
        if role_value in {"character", "executor"}:
            return ModelPool.TEXT
    return None


def _build_default_model_targets() -> list[dict[str, Any]]:
    defaults = settings.default_models
    targets: list[dict[str, Any]] = []

    if defaults.text_models:
        primary_text = defaults.text_models[0]
        targets.append(
            {
                "repo_id": primary_text.repo_id,
                "filename": primary_text.filename,
                "role": ModelPool.TEXT,
                "display_name": primary_text.display_name,
            }
        )

    if defaults.embedding:
        targets.append(
            {
                "repo_id": defaults.embedding.repo_id,
                "filename": defaults.embedding.filename,
                "role": ModelPool.EMBEDDING,
                "display_name": defaults.embedding.display_name,
            }
        )

    return targets


def _build_targets_from_custom_models(
    custom_models: dict[str, dict[str, str]] | None,
) -> list[dict[str, Any]]:
    if not custom_models:
        return []

    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str, ModelPool]] = set()
    role_map = {
        "text": ModelPool.TEXT,
        "character": ModelPool.TEXT,
        "executor": ModelPool.TEXT,
        "embedding": ModelPool.EMBEDDING,
    }

    for role_key, pool in role_map.items():
        model = custom_models.get(role_key)
        if not isinstance(model, dict):
            continue

        repo_id = model.get("repo_id")
        filename = model.get("filename")
        if not repo_id or not filename:
            continue

        cache_key = (repo_id, filename, pool)
        if cache_key in seen:
            continue
        seen.add(cache_key)

        targets.append(
            {
                "repo_id": repo_id,
                "filename": filename,
                "role": pool,
                "display_name": model.get("display_name"),
            }
        )

    return targets


class DownloadManager:
    """
    ダウンロード操作の統合マネージャー

    - BinaryManager（llama.cpp）とModelManager（GGUF）を統合
    - 初回セットアップ
    - 要件チェック
    """

    def __init__(
        self,
        user_data_dir: Path | None = None,
        bundled_fallback: Path | None = None,
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
            binary_dir=self.user_data_dir / "bin",
            logs_dir=self.user_data_dir / "logs",
        )
        self._progress_callbacks: list[ProgressCallback] = []

        # サブマネージャーにもコールバックを転送
        self.binary_manager.on_progress(self._emit_progress)

        def _forward_model_progress(event: ModelsProgressEvent) -> None:
            # Convert models ProgressEvent to download ProgressEvent
            # Map status string to DownloadStatus enum
            status_value = (
                event.status.value if hasattr(event.status, "value") else str(event.status)
            )
            try:
                download_status = DownloadStatus(status_value)
            except ValueError:
                download_status = DownloadStatus.DOWNLOADING  # fallback
            self._emit_progress(
                ProgressEvent(
                    status=download_status,
                    progress=event.progress,
                    message=event.message,
                    total_bytes=event.total_bytes,
                    current_bytes=event.current_bytes,
                    speed_bps=event.speed_bps,
                    eta_seconds=event.eta_seconds,
                    job_id=event.job_id,
                )
            )

        self.model_manager.on_progress(_forward_model_progress)

    def _detect_bundled_fallback(self) -> Path | None:
        """
        同梱CPU版のパスを自動検出

        Tauriパッケージングされた場合:
          - Windows: 実行ファイルと同じディレクトリに resources/llama-cpu-fallback
          - macOS: .app/Contents/Resources/llama-cpu-fallback

        開発環境の場合:
          - frontend/src-tauri/resources/llama-cpu-fallback
        """
        # PyInstallerバンドル時
        if getattr(sys, "frozen", False):
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
                    logger.info("Found bundled fallback at: %s", candidate)
                    return candidate

        # 開発環境: プロジェクトルートから探す
        try:
            # このファイルからプロジェクトルートを推定
            # backend/src/core/download/manager.py -> backend -> project_root
            project_root = Path(__file__).resolve().parents[4]
            dev_fallback = (
                project_root / "frontend" / "src-tauri" / "resources" / "llama-cpu-fallback"
            )
            if dev_fallback.exists():
                logger.info("Found dev fallback at: %s", dev_fallback)
                return dev_fallback
        except Exception as e:
            logger.debug("Could not detect dev fallback: %s", e, exc_info=True)

        logger.warning("No bundled fallback found")
        return None

    def on_progress(self, callback: ProgressCallback) -> None:
        """進捗コールバックを登録"""
        self._progress_callbacks.append(callback)

    def remove_progress_callback(self, callback: ProgressCallback) -> None:
        """進捗コールバックを削除"""
        if callback in self._progress_callbacks:
            self._progress_callbacks.remove(callback)

    def _emit_progress(self, event: ProgressEvent) -> None:
        """進捗イベントを発火"""
        for callback in list(self._progress_callbacks):
            try:
                callback(event)
            except Exception as e:
                logger.warning("Progress callback error: %s", e, exc_info=True)

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
        def check_model(pool: ModelsModelPool) -> tuple[RequirementStatus, str | None]:
            model = self.model_manager.get_active_model(pool)
            if model and model.file_path.exists():
                return RequirementStatus.SATISFIED, model.display_name
            return RequirementStatus.MISSING, None

        text_status, text_name = check_model(ModelsModelPool.TEXT)
        embed_status, embed_name = check_model(ModelsModelPool.EMBEDDING)

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
        target_models: list[dict[str, Any]] | None = None,
        consent_provided: bool = False,
        custom_models: dict[str, dict[str, str]] | None = None,
        loader: str = "llama_cpp",
    ) -> SetupResult:
        """
        初回セットアップを実行

        Args:
            install_binary: llama.cppバイナリをインストールするか
            download_default_models: デフォルトモデルをダウンロードするか
            target_models: ダウンロード対象モデルの明示的なリスト。
                           [{repo_id, filename, role, display_name}, ...]
            custom_models: 旧形式のモデル指定。target_modelsが空の場合にのみ使用。
            loader: LLMローダータイプ ("llama_cpp" | "ollama")
        """
        errors: list[str] = []
        binary_installed = False
        models_installed: list[str] = []

        if loader == "ollama":
            install_binary = False
            logger.info("Loader is ollama, skipping binary installation.")

        if install_binary:
            self._emit_progress(
                ProgressEvent(
                    status=DownloadStatus.PENDING,
                    progress=0.0,
                    message="推論エンジンをセットアップ中...",
                )
            )

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

        if download_default_models:
            # ターゲットモデルリストの構築
            # 引数 target_models があればそれを優先。
            # なければ default_models から構築 (backend fallback when frontend sends nothing?)
            # Frontend should send the selection.

            if target_models:
                final_targets = target_models
            else:
                final_targets = _build_targets_from_custom_models(custom_models)
                if not final_targets:
                    final_targets = _build_default_model_targets()

            for model_cfg in final_targets:
                repo_id = model_cfg.get("repo_id")
                filename = model_cfg.get("filename")
                if not repo_id or not filename:
                    logger.warning("Skipping model with missing repo_id/filename: %s", model_cfg)
                    continue

                # normalize keys: 'role' vs 'pool'
                role_val = model_cfg.get("role") or model_cfg.get("pool")
                pool_enum = _normalize_model_pool(role_val)
                if not pool_enum:
                    logger.warning("Skipping model with invalid role: %s", role_val)
                    continue

                # Ollama: Skip TEXT models
                if loader == "ollama" and pool_enum == ModelPool.TEXT:
                    logger.info("Loader is ollama, skipping text model: %s", filename)
                    continue

                display_name = model_cfg.get("display_name") or f"{pool_enum.value} Model"

                self._emit_progress(
                    ProgressEvent(
                        status=DownloadStatus.PENDING,
                        progress=0.0,
                        message=f"モデルをダウンロード中: {display_name}",
                    )
                )

                # Convert download ModelPool to models ModelPool
                models_pool = ModelsModelPool(pool_enum.value)

                download_result = await self.model_manager.download_from_huggingface(
                    repo_id=repo_id,
                    filename=filename,
                    role=models_pool,
                    display_name=display_name,
                    consent_provided=consent_provided,
                )

                if download_result.success:
                    models_installed.append(display_name)
                else:
                    errors.append(
                        f"Model download failed ({display_name}): {download_result.error_message}"
                    )

        success = len(errors) == 0

        self._emit_progress(
            ProgressEvent(
                status=DownloadStatus.COMPLETED if success else DownloadStatus.FAILED,
                progress=1.0,
                message="セットアップ完了" if success else "セットアップ中にエラーが発生しました",
            )
        )

        return SetupResult(
            success=success,
            binary_installed=binary_installed,
            models_installed=models_installed,
            errors=errors,
        )

    def get_binary_path(self) -> Path | None:
        """llama.cpp実行ファイルのパスを取得"""
        return self.binary_manager.get_executable_path()

    def get_model_path(self, pool: ModelPool) -> Path | None:
        """指定プールのモデルパスを取得"""
        models_pool = ModelsModelPool(pool.value)
        return self.model_manager.get_model_path(models_pool)

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

    def get_character_model_path(self) -> Path | None:
        """キャラクターモデルのパスを取得"""
        return self.model_manager.get_character_model_path()

    def get_disk_free_space(self, path: Path | None = None) -> int:
        """
        指定パス（省略時はユーザーデータディレクトリ）の空き容量をバイト単位で取得
        """
        target = path or self.user_data_dir
        # Ensure directory exists or use parent if it doesn't (to check volume space)
        if not target.exists():
            target = target.parent
            if not target.exists():
                # Fallback to current working directory root
                target = Path(".")

        import shutil

        try:
            total, used, free = shutil.disk_usage(target)
            return free
        except Exception as e:
            logger.error("Failed to check disk space: %s", e)
            return 0

    def check_write_permission(self, path: Path | None = None) -> bool:
        """
        指定パス（省略時はユーザーデータディレクトリ）への書き込み権限を確認
        """
        target = path or self.user_data_dir
        try:
            if not target.exists():
                target.mkdir(parents=True, exist_ok=True)
            return os.access(target, os.W_OK)
        except Exception:
            return False
