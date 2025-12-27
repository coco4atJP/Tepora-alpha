"""
Setup API Routes - セットアップウィザード用APIエンドポイント

初回セットアップ、要件チェック、ダウンロード進捗などを提供
"""

import logging
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.core.config.loader import settings
from src.tepora_server.api.security import get_api_key

logger = logging.getLogger("tepora.server.api.setup")
router = APIRouter(prefix="/api/setup", tags=["setup"], dependencies=[Depends(get_api_key)])

# ジョブID単位の進捗管理（複数セッション対応）
_job_progress: Dict[str, Dict] = {}

# レガシー互換: デフォルトジョブIDで最後の進捗を保持
_current_job_id: str | None = None


class BinaryDownloadRequest(BaseModel):
    variant: str = "auto"  # auto, cuda-12.4, cpu-avx2, etc.


class ModelDownloadRequest(BaseModel):
    repo_id: str
    filename: str
    role: str  # character, executor, embedding
    display_name: str | None = None


class LocalModelRequest(BaseModel):
    file_path: str
    role: str
    display_name: str


def _get_download_manager():
    """DownloadManagerのインスタンスを取得（遅延インポート）"""
    try:
        from src.core.download import DownloadManager

        return DownloadManager()
    except ImportError as e:
        logger.error(f"DownloadManager not available: {e}")
        raise HTTPException(status_code=500, detail="Download manager not available")


@router.get("/requirements")
async def check_requirements():
    """
    初回起動時の要件チェック
    バイナリとモデルの状態を返す
    """
    try:
        dm = _get_download_manager()
        status = await dm.check_requirements()

        return {
            "is_ready": status.is_ready,
            "has_missing": status.has_any_missing,
            "binary": {
                "status": status.binary_status.value,
                "version": status.binary_version,
            },
            "models": {
                "character": {
                    "status": status.character_model_status.value,
                    "name": status.character_model_name,
                },
                "executor": {
                    "status": status.executor_model_status.value,
                    "name": status.executor_model_name,
                },
                "embedding": {
                    "status": status.embedding_model_status.value,
                    "name": status.embedding_model_name,
                },
            },
        }
    except Exception as e:
        logger.error(f"Failed to check requirements: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/binary/download")
async def download_binary(request: BinaryDownloadRequest):
    """
    llama.cppバイナリをダウンロード
    """
    global _job_progress, _current_job_id
    
    job_id = str(uuid.uuid4())
    _current_job_id = job_id
    _job_progress[job_id] = {"status": "pending", "progress": 0.0, "message": ""}

    try:
        from src.core.download import BinaryVariant

        dm = _get_download_manager()

        # 進捗コールバックを設定
        def on_progress(event):
            _job_progress[job_id] = {
                "status": event.status.value,
                "progress": event.progress,
                "message": event.message,
            }

        dm.on_progress(on_progress)

        # バリアントを解決
        variant = BinaryVariant.AUTO
        if request.variant != "auto":
            try:
                variant = BinaryVariant(request.variant)
            except ValueError:
                pass

        # ダウンロード開始（非同期）
        result = await dm.binary_manager.download_and_install(variant=variant)

        return {
            "success": result.success,
            "version": result.version,
            "variant": result.variant.value if result.variant else None,
            "error": result.error_message,
            "job_id": job_id,
        }
    except Exception as e:
        logger.error(f"Failed to download binary: {e}", exc_info=True)
        _job_progress[job_id] = {"status": "failed", "progress": 0.0, "message": str(e)}
        return JSONResponse(status_code=500, content={"error": str(e), "job_id": job_id})


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
        from src.core.download import ModelRole

        dm = _get_download_manager()

        # 進捗コールバックを設定
        def on_progress(event):
            _job_progress[job_id] = {
                "status": event.status.value,
                "progress": event.progress,
                "message": event.message,
            }

        dm.on_progress(on_progress)

        # ロールを解決
        role_map = {
            "character": ModelRole.CHARACTER,
            "executor": ModelRole.EXECUTOR,
            "embedding": ModelRole.EMBEDDING,
        }
        role = role_map.get(request.role)
        if not role:
            raise HTTPException(status_code=400, detail=f"Invalid role: {request.role}")

        # ダウンロード
        result = await dm.model_manager.download_from_huggingface(
            repo_id=request.repo_id,
            filename=request.filename,
            role=role,
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

        from src.core.download import ModelRole

        dm = _get_download_manager()

        role_map = {
            "character": ModelRole.CHARACTER,
            "executor": ModelRole.EXECUTOR,
            "embedding": ModelRole.EMBEDDING,
        }
        role = role_map.get(request.role)
        if not role:
            raise HTTPException(status_code=400, detail=f"Invalid role: {request.role}")

        success = await dm.model_manager.add_local_model(
            file_path=Path(request.file_path),
            role=role,
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
        return _job_progress.get(job_id, {"status": "unknown", "progress": 0.0, "message": "Job not found"})
    
    # レガシー互換: 最新のジョブを返す
    if _current_job_id and _current_job_id in _job_progress:
        return _job_progress[_current_job_id]
    
    return {"status": "idle", "progress": 0.0, "message": ""}


class RunSetupRequest(BaseModel):
    custom_models: Optional[Dict[str, Dict[str, str]]] = None


@router.post("/run")
async def run_initial_setup(request: Optional[RunSetupRequest] = None):
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
                status_code=404,
                content={"success": False, "error": "Model not found"}
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
        from src.core.download import ModelRole
        
        dm = _get_download_manager()
        
        # ロールを解決
        role_map = {
            "character": ModelRole.CHARACTER,
            "executor": ModelRole.EXECUTOR,
            "embedding": ModelRole.EMBEDDING,
        }
        role = role_map.get(request.role)
        if not role:
            raise HTTPException(status_code=400, detail=f"Invalid role: {request.role}")
        
        success = await dm.model_manager.set_active_model(role, request.model_id)
        
        if not success:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Model not found or invalid role"}
            )
        
        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to set active model: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


# --- ダウンロード制御エンドポイント ---


class DownloadActionRequest(BaseModel):
    job_id: str
    action: str  # "pause", "resume", "cancel"


@router.get("/default-models")
async def get_default_models():
    """
    設定ファイルからデフォルトモデルの定義を取得
    """
    try:
        defaults = settings.default_models
        return {
            "character": defaults.character.model_dump() if defaults.character else None,
            "executor": defaults.executor.model_dump() if defaults.executor else None,
            "embedding": defaults.embedding.model_dump() if defaults.embedding else None,
        }
    except Exception as e:
        logger.error(f"Failed to get default models: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


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
