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


# --- In-Memory Setup State ---
# セットアップ中の設定を一時保持する（完了するまでconfig.ymlには書き込まない）
class SetupSession:
    def __init__(self):
        self.language: str = "en"
        self.custom_models: dict[str, dict] | None = None
        self.job_id: str | None = None
        self._progress: dict[str, Any] = {"status": "idle", "progress": 0.0, "message": ""}

    def update_progress(self, status: str, progress: float, message: str):
        self._progress = {"status": status, "progress": progress, "message": message}

    def get_progress(self):
        return self._progress


_setup_session = SetupSession()

# --- Request Models ---


class InitSetupRequest(BaseModel):
    language: str


class ModelConfig(BaseModel):
    repo_id: str
    filename: str
    display_name: str | None = None


class SetupRunRequest(BaseModel):
    # If provided, overrides defaults
    custom_models: dict[str, ModelConfig | None] | None = None


class BinaryDownloadRequest(BaseModel):
    variant: str = "auto"


class ModelDownloadRequest(BaseModel):
    repo_id: str
    filename: str
    role: str
    display_name: str | None = None


class SetupFinishRequest(BaseModel):
    launch: bool = True


class LocalModelRequest(BaseModel):
    file_path: str
    role: str
    display_name: str


class CheckModelRequest(BaseModel):
    repo_id: str
    filename: str


class ReorderModelsRequest(BaseModel):
    role: str
    model_ids: list[str]


class SetCharacterModelRequest(BaseModel):
    model_id: str


class SetExecutorModelRequest(BaseModel):
    task_type: str
    model_id: str


# --- Helper Functions ---

# Singleton Check
_download_manager_instance = None


def _get_download_manager():
    global _download_manager_instance
    try:
        if _download_manager_instance is None:
            from src.core.download import DownloadManager

            _download_manager_instance = DownloadManager()
        return _download_manager_instance
    except ImportError as e:
        logger.error(f"DownloadManager not available: {e}")
        raise HTTPException(status_code=500, detail="Download manager not available")


# --- Endpoints ---


@router.post("/init")
async def init_setup(request: InitSetupRequest):
    """
    ステップ1: セットアップセッションの初期化（言語設定など）
    ここではまだファイルには書き込まない。
    """
    global _setup_session
    _setup_session.language = request.language
    logger.info(f"Setup session initialized with language: {request.language}")
    return {"success": True, "language": _setup_session.language}


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
        logger.error(f"Requirements check failed: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/default-models")
async def get_default_models():
    """
    推奨モデル設定を返す。backend key is 'character', frontend expects 'text'.
    """
    try:
        defaults = settings.default_models
        return {
            "text": defaults.character.model_dump() if defaults.character else None,
            "executor": defaults.executor.model_dump() if defaults.executor else None,
            "embedding": defaults.embedding.model_dump() if defaults.embedding else None,
        }
    except Exception as e:
        logger.error(f"Failed to get default models: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/run")
async def run_setup_job(request: SetupRunRequest):
    """
    セットアップの実行（バイナリダウンロード + モデルダウンロード）。
    長時間かかるため、バックグラウンドジョブとして実行する。
    """
    global _setup_session

    # 既に実行中ならエラー等は返さず、現在のジョブIDを返すなどの制御も可能だが
    # ここではシンプルに新規ジョブを開始する

    job_id = str(uuid.uuid4())
    _setup_session.job_id = job_id
    _setup_session.update_progress("pending", 0.0, "Starting setup...")

    # モデル設定を保存（セッション）
    if request.custom_models:
        # dict形式に変換して保持
        models_dict = {}
        for role, cfg in request.custom_models.items():
            if cfg:
                models_dict[role] = cfg.model_dump()
        _setup_session.custom_models = models_dict
    else:
        # デフォルトを使用する場合はNoneのままでOK（DownloadManagerがデフォルト使用）
        _setup_session.custom_models = None

    try:
        dm = _get_download_manager()

        # バックグラウンドタスクの定義
        async def _background_setup():
            try:
                # Progress Listener
                def on_progress(event):
                    _setup_session.update_progress(
                        event.status.value, event.progress, event.message
                    )

                dm.on_progress(on_progress)

                # Run Setup
                # custom_modelsがNoneでもbackend側でdefaultsを使うロジックがあるが、
                # 明示的に渡すほうが安全。
                target_models = _setup_session.custom_models

                logger.info(f"Starting setup job {job_id} with models: {target_models}")

                result = await dm.run_initial_setup(
                    install_binary=True, download_default_models=True, custom_models=target_models
                )

                if result.success:
                    _setup_session.update_progress(
                        "completed", 1.0, "Setup completed successfully!"
                    )
                else:
                    error_msg = "; ".join(result.errors)
                    _setup_session.update_progress("failed", 0.0, f"Setup failed: {error_msg}")

            except Exception as e:
                logger.error(f"Setup job error: {e}", exc_info=True)
                _setup_session.update_progress("failed", 0.0, f"Critical error: {str(e)}")

        # Start Task
        asyncio.create_task(_background_setup())

        return {"success": True, "job_id": job_id}

    except Exception as e:
        logger.error(f"Failed to start setup job: {e}", exc_info=True)
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
    global _setup_session

    try:
        import yaml

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
                    config_data = existing
            except Exception as e:
                logger.warning(f"Failed to read existing config, overwriting: {e}")

        # 書き込み
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(config_data, f, default_flow_style=False, allow_unicode=True)

        logger.info(f"Setup finished. Config saved to {config_path}")

        # 設定のリロードをトリガー
        try:
            config_manager.load_config(force_reload=True)
        except Exception:
            pass

        return {"success": True, "path": str(config_path)}

    except Exception as e:
        logger.error(f"Finish setup failed: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


# --- Legacy/Helper Endpoints (kept for compatibility or specific tools) ---


@router.post("/binary/download")
async def download_binary_direct(request: BinaryDownloadRequest):
    # Setup process should be used via /run, but keeping this for manual tools if needed
    # ... (Implementation omitted for brevity, discouraged in new flow)
    return JSONResponse(status_code=501, content={"error": "Use /api/setup/run for installation"})


@router.post("/model/download")
async def download_model_direct(request: ModelDownloadRequest):
    # ... (Implementation omitted)
    return JSONResponse(status_code=501, content={"error": "Use /api/setup/run for installation"})


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
                "release_notes": update_info.release_notes,
            }

        current_version = await dm.binary_manager.get_current_version()
        return {
            "has_update": False,
            "current_version": current_version,
        }
    except Exception as e:
        logger.error(f"Failed to check for updates: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/binary/update")
async def update_binary_action(
    request: BinaryDownloadRequest,
):
    """
    llama.cppを更新（再インストール）
    """
    # Use /api/setup/run for installation flow
    return JSONResponse(status_code=501, content={"error": "Use /api/setup/run for installation"})


@router.post("/model/download")
async def download_model(request: ModelDownloadRequest):
    """
    HuggingFaceからモデルをダウンロード
    """
    global _job_progress, _current_job_id

    job_id = str(uuid.uuid4())
    _current_job_id = job_id
    _job_progress[job_id] = {"status": "pending", "progress": 0.0, "message": ""}

    try:
        from src.core.download import ModelPool

        dm = _get_download_manager()

        # 進捗コールバックを設定
        def on_progress(event):
            _job_progress[job_id] = {
                "status": event.status.value,
                "progress": event.progress,
                "message": event.message,
            }

        dm.on_progress(on_progress)

        # プールを解決
        pool_map = {
            "text": ModelPool.TEXT,
            "embedding": ModelPool.EMBEDDING,
        }
        pool = pool_map.get(request.role)
        if not pool:
            raise HTTPException(status_code=400, detail=f"Invalid pool: {request.role}")

        # ダウンロード
        result = await dm.model_manager.download_from_huggingface(
            repo_id=request.repo_id,
            filename=request.filename,
            role=pool,
            display_name=request.display_name,
        )

        return {
            "success": result.success,
            "path": str(result.path) if result.path else None,
            "error": result.error_message,
        }
    except Exception as e:
        logger.error(f"Failed to download model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/model/local")
async def add_local_model(request: LocalModelRequest):
    """
    ローカルモデルを追加
    """
    try:
        from pathlib import Path

        from src.core.download import ModelPool

        dm = _get_download_manager()

        pool_map = {
            "text": ModelPool.TEXT,
            "embedding": ModelPool.EMBEDDING,
        }
        pool = pool_map.get(request.role)
        if not pool:
            raise HTTPException(status_code=400, detail=f"Invalid pool: {request.role}")

        success = await dm.model_manager.add_local_model(
            file_path=Path(request.file_path),
            role=pool,
            display_name=request.display_name,
        )

        return {"success": success}
    except Exception as e:
        logger.error(f"Failed to add local model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.get("/progress")
async def get_progress(job_id: str | None = None):
    """
    現在のダウンロード進捗を取得

    Args:
        job_id: ジョブID（指定なしの場合は最新のジョブ）
    """
    if job_id:
        return _job_progress.get(
            job_id, {"status": "unknown", "progress": 0.0, "message": "Job not found"}
        )

    # レガシー互換: 最新のジョブを返す
    if _current_job_id and _current_job_id in _job_progress:
        return _job_progress[_current_job_id]

    return {"status": "idle", "progress": 0.0, "message": ""}


class RunSetupRequest(BaseModel):
    custom_models: dict[str, dict[str, str] | None] | None = None


@router.post("/run")
async def run_initial_setup(request: RunSetupRequest | None = None):
    """
    初回セットアップを完全に実行
    （バイナリ + デフォルトモデルのダウンロード）
    """
    global _job_progress, _current_job_id

    job_id = str(uuid.uuid4())
    _current_job_id = job_id
    _job_progress[job_id] = {"status": "pending", "progress": 0.0, "message": ""}

    try:
        dm = _get_download_manager()

        def on_progress(event):
            _job_progress[job_id] = {
                "status": event.status.value,
                "progress": event.progress,
                "message": event.message,
            }

        dm.on_progress(on_progress)

        result = await dm.run_initial_setup(
            custom_models=request.custom_models if request else None
        )

        return {
            "success": result.success,
            "binary_installed": result.binary_installed,
            "models_installed": result.models_installed,
            "errors": result.errors,
            "job_id": job_id,
        }
    except Exception as e:
        logger.error(f"Failed to run initial setup: {e}", exc_info=True)
        _job_progress[job_id] = {"status": "failed", "progress": 0.0, "message": str(e)}
        return JSONResponse(status_code=500, content={"error": str(e), "job_id": job_id})


@router.get("/models")
async def get_models():
    """
    利用可能なモデル一覧を取得
    """
    try:
        dm = _get_download_manager()
        models = dm.model_manager.get_available_models()

        return {
            "models": [
                {
                    "id": m.id,
                    "display_name": m.display_name,
                    "role": m.role.value,
                    "file_size": m.file_size,
                    "filename": m.filename,
                    "source": m.source,
                    "is_active": m.is_active,
                }
                for m in models
            ]
        }
    except Exception as e:
        logger.error(f"Failed to get models: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


class SetActiveModelRequest(BaseModel):
    model_id: str
    role: str  # character, executor, embedding


@router.delete("/model/{model_id}")
async def delete_model(model_id: str):
    """
    モデルを削除
    """
    try:
        dm = _get_download_manager()
        success = await dm.model_manager.delete_model(model_id)

        if not success:
            return JSONResponse(
                status_code=404, content={"success": False, "error": "Model not found"}
            )

        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to delete model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@router.post("/model/active")
async def set_active_model(request: SetActiveModelRequest):
    """
    アクティブモデルを設定
    """
    try:
        from src.core.download import ModelPool

        dm = _get_download_manager()

        # プールを解決
        pool_map = {
            "text": ModelPool.TEXT,
            "embedding": ModelPool.EMBEDDING,
        }
        pool = pool_map.get(request.role)
        if not pool:
            raise HTTPException(status_code=400, detail=f"Invalid pool: {request.role}")

        success = await dm.model_manager.set_active_model(pool, request.model_id)

        if not success:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Model not found or invalid role"},
            )

        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to set active model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@router.post("/model/check")
async def check_model_existence(request: CheckModelRequest):
    """
    HuggingFaceにモデルが存在するか確認
    """
    try:
        dm = _get_download_manager()
        exists = await dm.model_manager.check_huggingface_repo(request.repo_id, request.filename)
        return {"exists": exists}
    except Exception as e:
        logger.error(f"Failed to check model existence: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/model/reorder")
async def reorder_models_endpoint(request: ReorderModelsRequest):
    """
    モデルの順序を更新
    """
    try:
        from src.core.download import ModelPool

        dm = _get_download_manager()

        pool_map = {
            "text": ModelPool.TEXT,
            "embedding": ModelPool.EMBEDDING,
        }
        pool = pool_map.get(request.role)
        if not pool:
            raise HTTPException(status_code=400, detail=f"Invalid pool: {request.role}")

        success = dm.model_manager.reorder_models(pool, request.model_ids)
        return {"success": success}
    except Exception as e:
        logger.error(f"Failed to reorder models: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


# --- ロールベースモデル選択エンドポイント ---


@router.get("/model/roles")
async def get_model_roles():
    """
    現在のモデルロール設定を取得
    """
    try:
        dm = _get_download_manager()

        return {
            "character_model_id": dm.model_manager.get_character_model_id(),
            "executor_model_map": dm.model_manager.registry.executor_model_map,
        }
    except Exception as e:
        logger.error(f"Failed to get model roles: {e}", exc_info=True)
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
        logger.error(f"Failed to set character model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@router.post("/model/roles/executor")
async def set_executor_model(request: SetExecutorModelRequest):
    """
    エグゼキューターモデルを設定（タスクタイプごと）
    """
    try:
        dm = _get_download_manager()
        success = dm.model_manager.set_executor_model(request.task_type, request.model_id)

        if not success:
            return JSONResponse(
                status_code=400, content={"success": False, "error": "Failed to set executor model"}
            )

        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to set executor model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@router.delete("/model/roles/executor/{task_type}")
async def remove_executor_model(task_type: str):
    """
    エグゼキューターモデルマッピングを削除
    """
    try:
        dm = _get_download_manager()
        success = dm.model_manager.remove_executor_model(task_type)

        if not success:
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "Cannot remove default or non-existent mapping",
                },
            )

        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to remove executor model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


# --- ダウンロード制御エンドポイント ---


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

    except Exception as e:
        logger.error(f"Failed to perform download action: {e}", exc_info=True)
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
        logger.error(f"Failed to get incomplete downloads: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})
