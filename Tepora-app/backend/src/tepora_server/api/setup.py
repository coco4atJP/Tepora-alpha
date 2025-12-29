"""
Setup API Routes - セットアップウィザード用APIエンドポイント

初回セットアップ、要件チェック、ダウンロード進捗などを提供
"""

import logging
import uuid
from typing import Dict, Optional
from fastapi import Request

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.core.config.loader import settings
from src.tepora_server.api.security import get_api_key
from src.tepora_server.state import get_app_state

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


# Singleton instance for DownloadManager
_download_manager_instance = None
# Set to hold strong references to background tasks
_background_tasks = set()


def _get_download_manager():
    """DownloadManagerのシングルトンインスタンスを取得（遅延インポート）"""
    global _download_manager_instance
    try:
        if _download_manager_instance is None:
            from src.core.download import DownloadManager
            _download_manager_instance = DownloadManager()
            logger.info("DownloadManager singleton initialized.")
        return _download_manager_instance
    except ImportError as e:
        logger.error(f"DownloadManager not available: {e}")
        raise HTTPException(status_code=500, detail="Download manager not available")


async def _run_binary_install_job(job_id: str, dm, variant, app_state):
    """
    バックグラウンドでバイナリのダウンロードとインストールを実行
    更新前に関連プロセスを停止する
    """
    global _job_progress
    
    try:
        # プロセス停止とクリーンアップ
        logger.info(f"Stopping LLM processes for update (Job: {job_id})")
        _job_progress[job_id] = {
            "status": "extracting",  # UI的には準備中フェーズとして扱う
            "progress": 0.0,
            "message": "既存のプロセスを停止中...",
        }
        
        if app_state and app_state.core and app_state.core.llm_manager:
            # 全てのモデルをアンロードし、プロセスをキル
            app_state.core.llm_manager.cleanup()
            
            # GCを強制実行してファイルハンドルを解放
            import gc
            gc.collect()
            
            # 少し待機してファイルロック解放を確実にする
            import asyncio
            await asyncio.sleep(2.0)
            
        # ダウンロードマネージャーの進捗コールバック設定
        def on_progress(event):
            _job_progress[job_id] = {
                "status": event.status.value,
                "progress": event.progress,
                "message": event.message,
            }

        dm.on_progress(on_progress)
        
        # ダウンロード実行
        result = await dm.binary_manager.download_and_install(variant=variant)
        
        if result.success:
            logger.info(f"Binary update success: {result.version}")
            _job_progress[job_id] = {
                "status": "completed",
                "progress": 1.0,
                "message": "アップデート完了",
            }
        else:
            logger.error(f"Binary update failed: {result.error_message}")
            _job_progress[job_id] = {
                "status": "failed",
                "progress": 0.0,
                "message": result.error_message or "Unknown error",
            }
            
    except Exception as e:
        logger.error(f"Binary update job exception: {e}", exc_info=True)
        _job_progress[job_id] = {
            "status": "failed",
            "progress": 0.0,
            "message": str(e),
        }


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
        logger.error(f"Failed to check requirements: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/binary/download")
async def download_binary(
    request: BinaryDownloadRequest,
    fastapi_req: Request,
):
    """
    llama.cppバイナリをダウンロード (バックグラウンド実行)
    """
    global _job_progress, _current_job_id
    
    job_id = str(uuid.uuid4())
    _current_job_id = job_id
    _job_progress[job_id] = {"status": "pending", "progress": 0.0, "message": "開始準備中..."}

    try:
        from src.core.download import BinaryVariant
        import asyncio

        dm = _get_download_manager()

        # バリアントを解決
        variant = BinaryVariant.AUTO
        if request.variant != "auto":
            try:
                variant = BinaryVariant(request.variant)
            except ValueError:
                pass

        # AppState取得
        app_state = get_app_state(fastapi_req)

        # asyncio.create_task でバックグラウンド実行
        task = asyncio.create_task(_run_binary_install_job(job_id, dm, variant, app_state))
        
        # タスクへの参照を保持しないとGCされる可能性がある
        # https://docs.python.org/3/library/asyncio-task.html#asyncio.create_task
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

        return {
            "success": True,
            "job_id": job_id,
            "message": "Download started in background"
        }
    except Exception as e:
        logger.error(f"Failed to start binary download: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


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
    fastapi_req: Request,
):
    """
    llama.cppを更新（再インストール）
    """
    # 既存のdownload_binaryロジックを再利用
    return await download_binary(request, fastapi_req)


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
                content={"success": False, "error": "Model not found or invalid role"}
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
                content={"success": False, "error": "Failed to set character model"}
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
                status_code=400,
                content={"success": False, "error": "Failed to set executor model"}
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
                content={"success": False, "error": "Cannot remove default or non-existent mapping"}
            )
        
        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to remove executor model: {e}", exc_info=True)
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
