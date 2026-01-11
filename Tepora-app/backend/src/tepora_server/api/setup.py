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
    # List of models to install. If empty, falls back to manager defaults (though frontend should provide).
    # Each item is {repo_id, filename, role, display_name}
    target_models: list[dict[str, Any]] | None = None
    acknowledge_warnings: bool = False


class ModelDownloadRequest(BaseModel):
    repo_id: str
    filename: str
    role: str
    display_name: str | None = None
    acknowledge_warnings: bool = False


class SetupFinishRequest(BaseModel):
    launch: bool = True


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


async def _sync_model_to_config(model_info):
    """Sync model selection to config.yml models_gguf section"""
    try:
        from src.core.config.service import get_config_service
        from src.core.download import ModelRole

        service = get_config_service()
        current_config = service.load_config()

        if "models_gguf" not in current_config:
            current_config["models_gguf"] = {}

        # Determine key based on role
        # Note: ModelRole enum values match what's in registry
        role = model_info.role
        key = "text_model" if role == ModelRole.TEXT else "embedding_model"

        # Check if exists in current config
        # Use .get() safely
        models_config = current_config.get("models_gguf", {})

        # Only add if not exists (preserve user customizations)
        if key not in models_config:
            logger.info(f"Syncing default config for {key} (model={model_info.id})")

            # Default port logic: 8080 for text, 8081 for embedding
            port = 8080 if key == "text_model" else 8081

            # Ensure path is relative if possible, or string absolute path
            model_path = str(model_info.file_path)

            # Create a patch (partial config) to merge
            patch_data = {
                "models_gguf": {
                    key: {
                        "path": model_path,
                        "port": port,
                        "n_ctx": 4096,
                        "n_gpu_layers": -1,
                        "temperature": 0.7,
                    }
                }
            }

            service.update_config(patch_data, merge=True)
            logger.info(f"Synced {key} to config.yml")

    except Exception as e:
        logger.warning(f"Failed in _sync_model_to_config: {e}")


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
        # Convert list of pydantic models to list of dicts
        text_models = [m.model_dump() for m in defaults.text_models]
        return {
            "text_models": text_models,
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
    # SetupRunRequest now sends a list of target models to install directly.
    target_models = request.target_models

    # Preflight policy checks (warnings/consent)
    try:
        dm = _get_download_manager()
        targets_for_policy = target_models or []
        if not targets_for_policy:
            defaults = settings.default_models
            if defaults.embedding:
                targets_for_policy = [
                    {
                        "repo_id": defaults.embedding.repo_id,
                        "filename": defaults.embedding.filename,
                        "role": "embedding",
                        "display_name": defaults.embedding.display_name,
                    }
                ]
        warnings = _evaluate_model_download_warnings(dm, targets_for_policy)
        if warnings and not request.acknowledge_warnings:
            return JSONResponse(
                status_code=409,
                content={
                    "success": False,
                    "requires_consent": True,
                    "warnings": warnings,
                },
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Preflight model policy check failed: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})

    # Store in session for reference (optional, but good for debugging)
    _setup_session.custom_models = {
        "targets": target_models
    }  # Storing as dict for compatibility with type hint if needed, or just leverage dynamic

    try:
        # バックグラウンドタスクの定義
        async def _background_setup():
            try:
                # Progress Listener
                def on_progress(event):
                    _setup_session.update_progress(
                        event.status.value, event.progress, event.message
                    )

                dm.on_progress(on_progress)

                logger.info(f"Starting setup job {job_id} with models: {target_models}")

                # Pass the list directly to run_initial_setup
                # Note: We need to update manager signature next
                result = await dm.run_initial_setup(
                    install_binary=True,
                    download_default_models=True,
                    target_models=target_models,
                    consent_provided=request.acknowledge_warnings,
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
        logger.error(f"Failed to download model: {e}", exc_info=True)
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
        logger.error(f"Failed to check model update: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})


