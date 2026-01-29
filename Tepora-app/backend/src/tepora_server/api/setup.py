"""
Setup API Routes - セットアップウィザード用APIエンドポイント (Refactored)

初回セットアップ、要件チェック、ダウンロード進捗などを提供。
ステートフルなセットアップフローを実現するために、一時的な設定保持と明示的な完了処理を導入。
"""

import asyncio
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.core.config.loader import USER_DATA_DIR, config_manager, settings
from src.tepora_server.api.security import get_api_key

logger = logging.getLogger("tepora.server.api.setup")
router = APIRouter(prefix="/api/setup", tags=["setup"], dependencies=[Depends(get_api_key)])


# imports must be delayed or structured differently if E402 persists, but simpler to suppress for this file structure
import json  # noqa: E402
from pathlib import Path  # noqa: E402


# --- In-Memory Setup State ---
# セットアップ中の設定を一時保持する（完了するまでconfig.ymlには書き込まない）
# v0.3.0: 永続化をサポートし、再起動後も状態を復元できるように変更
class SetupSession:
    def __init__(self):
        self.language: str = "en"
        self.loader: str = "llama_cpp"
        self.job_id: str | None = None
        self._progress: dict[str, Any] = {"status": "idle", "progress": 0.0, "message": ""}
        self.state_file: Path = USER_DATA_DIR / "setup_state.json"

        # 起動時に以前の状態があればロード
        self._load_state()

    def update_progress(self, status: str, progress: float, message: str):
        self._progress = {"status": status, "progress": progress, "message": message}
        if self.job_id:
            self._save_state()

    def set_language(self, language: str):
        self.language = language
        self._save_state()

    def set_loader(self, loader: str):
        self.loader = loader
        self._save_state()

    def set_job_id(self, job_id: str | None):
        self.job_id = job_id
        self._save_state()

    def get_progress(self):
        return self._progress

    def _save_state(self):
        try:
            data = {
                "language": self.language,
                "loader": self.loader,
                "job_id": self.job_id,
                "progress": self._progress,
            }
            with open(self.state_file, "w", encoding="utf-8") as f:
                json.dump(data, f)
        except Exception as e:
            logger.warning(f"Failed to save setup state: {e}")

    def _load_state(self):
        if not self.state_file.exists():
            return

        try:
            with open(self.state_file, encoding="utf-8") as f:
                data = json.load(f)
                self.language = data.get("language", "en")
                self.loader = data.get("loader", "llama_cpp")
                self.job_id = data.get("job_id")
                self._progress = data.get(
                    "progress", {"status": "idle", "progress": 0.0, "message": ""}
                )
                logger.info(
                    f"Restored setup session: job_id={self.job_id}, status={self._progress.get('status')}"
                )
        except Exception as e:
            logger.warning(f"Failed to load setup state: {e}")

    def clear_state(self):
        """セットアップ完了時に状態ファイルを削除"""
        self.job_id = None
        self._progress = {"status": "idle", "progress": 0.0, "message": ""}
        try:
            if self.state_file.exists():
                self.state_file.unlink()
        except Exception as e:
            logger.warning(f"Failed to delete setup state file: {e}")


_setup_session = SetupSession()

# --- Request Models ---


class InitSetupRequest(BaseModel):
    language: str


class SetupRunRequest(BaseModel):
    # List of models to install. If empty, falls back to manager defaults (though frontend should provide).
    # Each item is {repo_id, filename, role, display_name}
    target_models: list[dict[str, Any]] | None = None
    acknowledge_warnings: bool = False
    loader: str = "llama_cpp"


class ModelDownloadRequest(BaseModel):
    repo_id: str
    filename: str
    role: str
    display_name: str | None = None
    acknowledge_warnings: bool = False


class SetupFinishRequest(BaseModel):
    launch: bool = True


# --- Helper Functions ---

# DownloadManager accessor - uses AppState for shared instance
# Fallback singleton for background tasks that don't have request context
_download_manager_fallback = None


def _get_download_manager_from_state():
    """Get DownloadManager from global AppState (preferred)."""
    global _download_manager_fallback
    try:
        if _download_manager_fallback is None:
            from src.core.download import DownloadManager

            _download_manager_fallback = DownloadManager()
        return _download_manager_fallback
    except ImportError as e:
        logger.error("DownloadManager not available: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Download manager not available")


def _get_download_manager():
    """Get shared DownloadManager instance."""
    return _get_download_manager_from_state()


def _evaluate_model_download_warnings(
    dm, target_models: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    for model_cfg in target_models:
        repo_id = model_cfg.get("repo_id")
        filename = model_cfg.get("filename")
        if not repo_id or not filename:
            continue
        policy = dm.model_manager.evaluate_download_policy(repo_id, filename)
        if not policy.allowed:
            raise HTTPException(status_code=400, detail=policy.warnings[0])
        if policy.requires_consent:
            warnings.append(
                {
                    "repo_id": repo_id,
                    "filename": filename,
                    "warnings": policy.warnings,
                }
            )
    return warnings


def _resolve_model_pool(role: str):
    from src.core.download import ModelPool

    if isinstance(role, ModelPool):
        return role

    normalized = str(role).lower() if role else ""
    pool_map = {
        "text": ModelPool.TEXT,
        "character": ModelPool.TEXT,
        "professional": ModelPool.TEXT,
        "executor": ModelPool.TEXT,
        "embedding": ModelPool.EMBEDDING,
    }
    pool = pool_map.get(normalized)
    if not pool:
        raise HTTPException(status_code=400, detail=f"Invalid role: {role}")
    return pool


def _format_progress_status(status: object) -> str:
    if hasattr(status, "value"):
        return str(status.value)
    return str(status)


# --- Endpoints ---


@router.post("/init")
async def init_setup(request: InitSetupRequest):
    """
    ステップ1: セットアップセッションの初期化（言語設定など）
    ここではまだファイルには書き込まない。
    """
    _setup_session.set_language(request.language)
    logger.info("Setup session initialized with language: %s", request.language)
    return {"success": True, "language": _setup_session.language}


class PreflightRequest(BaseModel):
    required_space_mb: int = 4096  # Default ~4GB


@router.post("/preflight")
async def check_preflight(request: PreflightRequest):
    """
    セットアップ開始前の事前チェック (ディスク容量、権限)
    """
    try:
        dm = _get_download_manager()

        # Permission Check
        has_permission = dm.check_write_permission()
        if not has_permission:
            return JSONResponse(
                status_code=403,
                content={
                    "success": False,
                    "error": "Write permission denied for user data directory.",
                },
            )

        # Disk Space Check
        free_bytes = dm.get_disk_free_space()
        required_bytes = request.required_space_mb * 1024 * 1024

        if free_bytes < required_bytes:
            return JSONResponse(
                status_code=507,  # Insufficient Storage
                content={
                    "success": False,
                    "error": f"Insufficient disk space. Required: {request.required_space_mb}MB, Available: {free_bytes // (1024 * 1024)}MB",
                },
            )

        return {"success": True, "available_mb": free_bytes // (1024 * 1024)}

    except Exception as e:
        logger.error("Preflight check failed: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/requirements")
async def check_requirements():
    """
    要件チェック。
    現在のインストール状態を返す。
    """
    try:
        dm = _get_download_manager()
        status = await dm.check_requirements()

        # 簡易レスポンス形式に変換
        return {
            "is_ready": status.is_ready,
            "has_missing": status.has_any_missing,
            "binary": {
                "status": status.binary_status.value,
                "version": status.binary_version,
            },
            "models": {
                "text": {
                    "status": status.text_model_status.value,
                    "name": status.text_model_name,
                },
                "embedding": {
                    "status": status.embedding_model_status.value,
                    "name": status.embedding_model_name,
                },
            },
        }
    except Exception as e:
        logger.error("Requirements check failed: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/default-models")
async def get_default_models():
    """
    推奨モデル設定を返す。backend key is 'character', frontend expects 'text'.
    """
    try:
        defaults = settings.default_models
        # Convert list of pydantic models to list of dicts
        text_models = [m.model_dump() for m in defaults.text_models]
        return {
            "text_models": text_models,
            "embedding": defaults.embedding.model_dump() if defaults.embedding else None,
        }
    except Exception as e:
        logger.error("Failed to get default models: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/run")
async def run_setup_job(request: SetupRunRequest):
    """
    セットアップの実行（バイナリダウンロード + モデルダウンロード）。
    長時間かかるため、バックグラウンドジョブとして実行する。
    """
    # 既に実行中ならエラー等は返さず、現在のジョブIDを返すなどの制御も可能だが
    # ここではシンプルに新規ジョブを開始する

    job_id = str(uuid.uuid4())
    _setup_session.set_job_id(job_id)
    _setup_session.update_progress("pending", 0.0, "Starting setup...")

    # モデル設定を保存（セッション）
    _setup_session.set_loader(request.loader)

    # SetupRunRequest now sends a list of target models to install directly.
    target_models = request.target_models

    # Preflight policy checks (warnings/consent)
    try:
        dm = _get_download_manager()
        targets_for_policy = target_models or []
        if not targets_for_policy and request.loader != "ollama":
            # Defaults fallbacks only if NOT ollama (since ollama skips text models)
            # Actually logic inside download manager handles defaults building
            # Checking policy for defaults:
            defaults = settings.default_models
            if defaults.embedding:
                targets_for_policy.append(
                    {
                        "repo_id": defaults.embedding.repo_id,
                        "filename": defaults.embedding.filename,
                        "role": "embedding",
                        "display_name": defaults.embedding.display_name,
                    }
                )
            # If NOT ollama, add text models? Frontend sends target_models.
            # If frontend sent empty, it means defaults.
            # But if ollama, frontend sends empty or just embedding.
            # We can rely on targets_for_policy being what is requested.

        warnings = _evaluate_model_download_warnings(dm, targets_for_policy)
        if warnings and not request.acknowledge_warnings:
            # Consents required, so we clear the speculative job ID to avoid "pending" state on resume
            _setup_session.set_job_id(None)  # type: ignore
            return JSONResponse(
                status_code=409,
                content={
                    "success": False,
                    "requires_consent": True,
                    "warnings": warnings,
                },
            )
    except HTTPException:
        _setup_session.set_job_id(None)
        raise
    except Exception as e:
        _setup_session.set_job_id(None)
        logger.error("Preflight model policy check failed: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})

    try:
        # バックグラウンドタスクの定義
        async def _background_setup():
            def on_progress(event):
                _setup_session.update_progress(
                    _format_progress_status(event.status),
                    event.progress,
                    event.message,
                )

            try:
                dm.on_progress(on_progress)

                logger.info("Starting setup job %s with models: %s", job_id, target_models)

                result = await dm.run_initial_setup(
                    install_binary=True,  # Will be overridden inside if loader is ollama
                    download_default_models=True,
                    target_models=target_models,
                    consent_provided=request.acknowledge_warnings,
                    loader=request.loader,
                )

                if result.success:
                    _setup_session.update_progress(
                        "completed", 1.0, "Setup completed successfully!"
                    )
                else:
                    error_msg = "; ".join(result.errors)
                    _setup_session.update_progress("failed", 0.0, f"Setup failed: {error_msg}")

            except Exception as e:
                logger.error("Setup job error: %s", e, exc_info=True)
                _setup_session.update_progress("failed", 0.0, f"Critical error: {str(e)}")
            finally:
                dm.remove_progress_callback(on_progress)

        # Start Task
        asyncio.create_task(_background_setup())

        return {"success": True, "job_id": job_id}

    except Exception as e:
        _setup_session.set_job_id(None)
        logger.error("Failed to start setup job: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/progress")
async def get_setup_progress():
    """
    現在のセットアップ進捗を取得
    """
    return _setup_session.get_progress()


@router.post("/finish")
async def finish_setup(request: SetupFinishRequest):
    """
    セットアップ完了処理。
    1. 設定ファイル(config.yml)の生成・保存（言語設定、初回完了フラグなど）
    2. 必要ならアプリの再起動やリロード指示
    """
    try:
        import yaml  # type: ignore[import-untyped]

        # 保存すべき設定データの構築
        config_data = {"app": {"language": _setup_session.language, "setup_completed": True}}

        # 既存のconfig.ymlがあれば読み込んでマージする（上書き回避）
        config_path = USER_DATA_DIR / "config.yml"
        if config_path.exists():
            try:
                with open(config_path, encoding="utf-8") as f:
                    existing = yaml.safe_load(f) or {}
                    # Deep merge helper (simplified)
                    if "app" not in existing:
                        existing["app"] = {}
                    existing["app"]["language"] = _setup_session.language
                    existing["app"]["setup_completed"] = True

                    if "llm_manager" not in existing:
                        existing["llm_manager"] = {}
                    existing["llm_manager"]["loader"] = _setup_session.loader

                    config_data = existing
            except Exception as e:
                logger.warning("Failed to read existing config, overwriting: %s", e, exc_info=True)

        # 書き込み
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(config_data, f, default_flow_style=False, allow_unicode=True)

        logger.info("Setup finished. Config saved to %s", config_path)

        # 設定のリロードをトリガー
        try:
            config_manager.load_config(force_reload=True)
        except Exception as e:
            logger.warning("Failed to reload config after setup: %s", e, exc_info=True)

        # 完了したので一時ステートファイルを削除
        _setup_session.clear_state()

        return {"success": True, "path": str(config_path)}

    except Exception as e:
        logger.error("Finish setup failed: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/model/download")
async def download_model(request: ModelDownloadRequest):
    """
    HuggingFaceからモデルをダウンロード
    """
    try:
        dm = _get_download_manager()

        policy = dm.model_manager.evaluate_download_policy(request.repo_id, request.filename)
        if not policy.allowed:
            raise HTTPException(status_code=400, detail=policy.warnings[0])
        if policy.requires_consent and not request.acknowledge_warnings:
            return JSONResponse(
                status_code=409,
                content={
                    "success": False,
                    "requires_consent": True,
                    "warnings": policy.warnings,
                },
            )

        pool = _resolve_model_pool(request.role)

        # ダウンロード
        result = await dm.model_manager.download_from_huggingface(
            repo_id=request.repo_id,
            filename=request.filename,
            role=pool,
            display_name=request.display_name,
            consent_provided=request.acknowledge_warnings,
        )

        if result.requires_consent:
            return JSONResponse(
                status_code=409,
                content={
                    "success": False,
                    "requires_consent": True,
                    "warnings": result.warnings,
                },
            )

        return {
            "success": result.success,
            "path": str(result.path) if result.path else None,
            "error": result.error_message,
        }
    except Exception as e:
        logger.error("Failed to download model: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/model/update-check")
async def check_model_update(
    model_id: str | None = None,
    repo_id: str | None = None,
    filename: str | None = None,
):
    """
    HuggingFaceの最新リビジョンと比較して更新があるかチェック
    """
    try:
        dm = _get_download_manager()

        if model_id:
            model = next(
                (m for m in dm.model_manager.get_available_models() if m.id == model_id),
                None,
            )
            if not model:
                raise HTTPException(status_code=404, detail="Model not found")
            if not model.repo_id or not model.filename:
                raise HTTPException(status_code=400, detail="Model is not from HuggingFace")

            return dm.model_manager.check_huggingface_update(
                repo_id=model.repo_id,
                filename=model.filename,
                current_revision=model.revision,
                current_sha256=model.sha256,
                current_path=model.file_path,
            )

        if not repo_id or not filename:
            raise HTTPException(status_code=400, detail="repo_id and filename are required")

        return dm.model_manager.check_huggingface_update(
            repo_id=repo_id,
            filename=filename,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to check model update: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/models")
async def get_models():
    """
    ダウンロード済みモデル一覧を取得
    """
    try:
        dm = _get_download_manager()
        models = dm.model_manager.get_available_models()

        active_text_id = (
            dm.model_manager.get_character_model_id()
            or dm.model_manager.get_assigned_model_id("professional")
        )
        active_embedding_id = dm.model_manager.get_assigned_model_id("embedding")

        result = []
        for model in models:
            role_value = model.role.value if hasattr(model.role, "value") else str(model.role)
            is_active = False
            if role_value == "text":
                is_active = model.id == active_text_id
            elif role_value == "embedding":
                is_active = model.id == active_embedding_id

            result.append(
                {
                    "id": model.id,
                    "display_name": model.display_name or model.id,
                    "role": role_value,
                    "file_size": model.file_size or 0,
                    "filename": model.filename,
                    "source": model.repo_id or "local",
                    "is_active": is_active,
                }
            )

        return {"models": result}
    except Exception as e:
        logger.error("Failed to get models: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


class ModelCheckRequest(BaseModel):
    repo_id: str
    filename: str


@router.post("/model/check")
async def check_model_exists(request: ModelCheckRequest):
    """
    HuggingFaceリポジトリにモデルファイルが存在するか確認
    """
    try:
        dm = _get_download_manager()
        size = dm.model_manager.get_remote_file_size(request.repo_id, request.filename)

        if size is not None:
            return {"exists": True, "size": size}
        else:
            return {"exists": False}

    except Exception as e:
        logger.error("Failed to check model: %s", e, exc_info=True)
        return {"exists": False, "error": str(e)}


class LocalModelRequest(BaseModel):
    file_path: str
    role: str
    display_name: str | None = None


@router.post("/model/local")
async def register_local_model(request: LocalModelRequest):
    """
    ローカルのGGUFファイルをモデルとして登録
    """
    try:
        from pathlib import Path

        dm = _get_download_manager()

        file_path = Path(request.file_path)
        if not file_path.exists():
            raise HTTPException(status_code=400, detail=f"File not found: {file_path}")

        if not file_path.suffix.lower() == ".gguf":
            raise HTTPException(status_code=400, detail="Only .gguf files are supported")

        pool = _resolve_model_pool(request.role)

        result = await dm.model_manager.register_local_model(
            file_path=file_path,
            role=pool,
            display_name=request.display_name or file_path.stem,
        )

        success = result.success if hasattr(result, "success") else bool(result)
        model_id = (
            result.model_id
            if hasattr(result, "model_id")
            else (file_path.stem if success else None)
        )

        return {
            "success": success,
            "model_id": model_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to register local model: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/models/ollama/refresh")
async def refresh_ollama_models():
    """
    Refresh list of Ollama models from the running Ollama instance.
    """
    try:
        dm = _get_download_manager()
        synced_ids = await dm.model_manager.sync_ollama_models()
        return {"success": True, "synced_models": synced_ids}
    except Exception as e:
        logger.error("Failed to sync Ollama models: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.delete("/model/{model_id}")
async def delete_model(model_id: str):
    """
    モデルを削除
    """
    try:
        dm = _get_download_manager()
        result = await dm.model_manager.delete_model(model_id)
        return {"success": result}
    except Exception as e:
        logger.error("Failed to delete model: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


class ReorderRequest(BaseModel):
    role: str
    model_ids: list[str]


@router.post("/model/reorder")
async def reorder_models(request: ReorderRequest):
    """
    モデルの優先順位を変更
    """
    try:
        dm = _get_download_manager()

        pool = _resolve_model_pool(request.role)

        result = dm.model_manager.reorder_models(pool, request.model_ids)
        return {"success": result}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to reorder models: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


class ActiveModelRequest(BaseModel):
    model_id: str
    role: str


@router.post("/model/active")
async def set_active_model(request: ActiveModelRequest):
    """
    Legacy endpoint: set active model for a pool.

    Frontend uses this for embedding selection; V3 stores this as a role assignment.
    """
    try:
        dm = _get_download_manager()
        pool = _resolve_model_pool(request.role)

        if pool.value == "embedding":
            success = dm.model_manager.set_role_model("embedding", request.model_id)
        else:
            # TEXT pool maps to "character" role
            success = dm.model_manager.set_character_model(request.model_id)

        if not success:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Failed to set active model"},
            )

        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to set active model: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


# --- Binary Update Endpoints ---


class BinaryUpdateRequest(BaseModel):
    variant: str = "auto"


@router.get("/binary/update-info")
async def check_binary_update():
    """
    llama.cppの更新をチェック
    """
    try:
        dm = _get_download_manager()

        # 常に最新のレジストリを取得する
        dm.binary_manager.reload_registry()

        update_info = await dm.binary_manager.check_for_updates()

        if update_info:
            return {
                "has_update": True,
                "current_version": update_info.current_version,
                "latest_version": update_info.latest_version,
                "release_notes": getattr(update_info, "release_notes", None),
            }

        current_version = await dm.binary_manager.get_current_version()
        return {
            "has_update": False,
            "current_version": current_version,
        }
    except Exception as e:
        logger.error("Failed to check for updates: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/binary/update")
async def update_binary(request: BinaryUpdateRequest):
    """
    llama.cppを更新（バックグラウンドジョブ）
    """
    job_id = str(uuid.uuid4())
    _setup_session.set_job_id(job_id)
    _setup_session.update_progress("pending", 0.0, "Starting binary update...")

    try:
        dm = _get_download_manager()

        async def _background_update():
            def on_progress(event):
                _setup_session.update_progress(
                    _format_progress_status(event.status),
                    event.progress,
                    event.message,
                )

            try:
                dm.on_progress(on_progress)
                result = await dm.binary_manager.install_llama_cpp(variant=request.variant)

                if result.success:
                    _setup_session.update_progress("completed", 1.0, f"Updated to {result.version}")
                else:
                    _setup_session.update_progress(
                        "failed", 0.0, f"Update failed: {result.error_message}"
                    )
            except Exception as e:
                logger.error("Binary update error: %s", e, exc_info=True)
                _setup_session.update_progress("failed", 0.0, f"Critical error: {str(e)}")
            finally:
                dm.remove_progress_callback(on_progress)

        asyncio.create_task(_background_update())
        return {"success": True, "job_id": job_id}

    except Exception as e:
        logger.error("Failed to start binary update: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


# --- Download Control Endpoints ---


class DownloadActionRequest(BaseModel):
    job_id: str
    action: str  # "pause", "resume", "cancel"


@router.post("/download/action")
async def download_action(request: DownloadActionRequest):
    """
    ダウンロードを一時停止/再開/キャンセル
    """
    try:
        dm = _get_download_manager()

        if request.action == "pause":
            success = dm.binary_manager.pause_download(request.job_id)
            return {
                "success": success,
                "message": "Download paused" if success else "Failed to pause",
            }

        elif request.action == "cancel":
            success = dm.binary_manager.cancel_download(request.job_id)
            return {
                "success": success,
                "message": "Download cancelled" if success else "Failed to cancel",
            }

        elif request.action == "resume":
            result = await dm.binary_manager.resume_download(request.job_id)
            return {
                "success": result.success,
                "version": result.version,
                "error": result.error_message,
            }

        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {request.action}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to perform download action: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/download/incomplete")
async def get_incomplete_downloads():
    """
    未完了（中断/失敗）のダウンロード一覧を取得
    レジューム可能なダウンロードを確認するために使用
    """
    try:
        dm = _get_download_manager()
        jobs = dm.binary_manager.get_incomplete_downloads()

        return {
            "jobs": [
                {
                    "job_id": job.job_id,
                    "status": job.status.value,
                    "target_url": job.target_url,
                    "downloaded_bytes": job.downloaded_bytes,
                    "total_bytes": job.total_bytes,
                    "progress": job.downloaded_bytes / job.total_bytes
                    if job.total_bytes > 0
                    else 0,
                    "error_message": job.error_message,
                }
                for job in jobs
            ]
        }
    except Exception as e:
        logger.error("Failed to get incomplete downloads: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


# --- Role-based Model Selection Endpoints ---


class SetCharacterModelRequest(BaseModel):
    model_id: str


class ProfessionalRoleRequest(BaseModel):
    task_type: str
    model_id: str


@router.get("/model/roles")
async def get_model_roles():
    """
    現在のモデルロール設定を取得
    """
    try:
        dm = _get_download_manager()
        roles = dm.model_manager.registry.roles

        # Reconstruct legacy professional map from V3 roles
        professional_map = {}
        for role_key, model_id in roles.items():
            if role_key == "professional":
                professional_map["default"] = model_id
            elif role_key.startswith("professional:"):
                task = role_key.split(":", 1)[1]
                professional_map[task] = model_id

        return {
            "character_model_id": dm.model_manager.get_character_model_id(),
            "professional_model_map": professional_map,
        }
    except Exception as e:
        logger.error("Failed to get model roles: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/model/roles/character")
async def set_character_model(request: SetCharacterModelRequest):
    """
    キャラクターモデルを設定
    """
    try:
        dm = _get_download_manager()
        success = dm.model_manager.set_character_model(request.model_id)

        if not success:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Failed to set character model"},
            )

        return {"success": True}
    except Exception as e:
        logger.error("Failed to set character model: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@router.post("/model/roles/professional")
async def update_professional_role(request: ProfessionalRoleRequest):
    """
    プロフェッショナルモデル（旧Executor）の割り当て更新
    """
    try:
        dm = _get_download_manager()

        role_key = "professional"
        if request.task_type and request.task_type != "default":
            role_key = f"professional:{request.task_type}"

        success = dm.model_manager.set_role_model(role_key, request.model_id)
        if not success:
            raise HTTPException(status_code=400, detail="Failed to set professional model")
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to set professional model: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.delete("/model/roles/professional/{task_type}")
async def remove_professional_role(task_type: str):
    """
    プロフェッショナルモデルの割り当て解除
    """
    try:
        dm = _get_download_manager()

        role_key = "professional"
        if task_type and task_type != "default":
            role_key = f"professional:{task_type}"

        success = dm.model_manager.remove_role_assignment(role_key)
        return {"success": success}
    except Exception as e:
        logger.error("Failed to remove professional model: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})
