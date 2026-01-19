"""
Model Manager - GGUFモデルの管理

機能:
- HuggingFace Hubからダウンロード
- ローカルファイルの追加（選択/D&D）
- モデル情報の取得
- アクティブモデルの管理
"""

import asyncio
import hashlib
import json
import logging
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .types import ModelInfo, ModelPool, ModelRegistry, ProgressCallback, ProgressEvent

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def _repo_id_from_url(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 2:
        return "/".join(parts[:2])
    return None


def _get_repo_owner(repo_id: str | None) -> str | None:
    if not repo_id:
        return None
    parts = repo_id.split("/")
    if not parts:
        return None
    return parts[0].lower()


def _get_attr(obj: object, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _extract_sha256(file_info: object) -> str | None:
    lfs = _get_attr(file_info, "lfs")
    if isinstance(lfs, dict):
        return lfs.get("sha256") or lfs.get("sha") or lfs.get("oid")
    if lfs:
        result = _get_attr(lfs, "sha256") or _get_attr(lfs, "sha")
        return str(result) if result else None
    result = _get_attr(file_info, "oid") or _get_attr(file_info, "blob_id")
    return str(result) if result else None


def _fetch_hf_file_metadata(repo_id: str, filename: str, revision: str | None = None) -> dict:
    _, hf_api_cls = _get_hf_hub()
    if hf_api_cls is None:
        return {}

    api = hf_api_cls()
    try:
        info = api.model_info(repo_id, revision=revision, files_metadata=True)
    except TypeError:
        # Older huggingface_hub without files_metadata support
        info = api.model_info(repo_id, revision=revision)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to fetch HuggingFace metadata: %s", exc, exc_info=True)
        return {}

    siblings = _get_attr(info, "siblings") or []
    file_info = None
    for sibling in siblings:
        if _get_attr(sibling, "rfilename") == filename:
            file_info = sibling
            break

    return {
        "revision": _get_attr(info, "sha"),
        "sha256": _extract_sha256(file_info) if file_info else None,
        "size": _get_attr(file_info, "size") if file_info else None,
    }


@dataclass
class DownloadPolicyDecision:
    allowed: bool
    requires_consent: bool
    warnings: list[str]
    revision: str | None
    expected_sha256: str | None


@dataclass
class DownloadResult:
    """ダウンロード結果"""

    success: bool
    path: Path | None = None
    error_message: str | None = None
    requires_consent: bool = False
    warnings: list[str] | None = None


class DownloadStatus:
    """ダウンロード状態"""

    PENDING = "pending"
    DOWNLOADING = "downloading"
    PAUSED = "paused"
    EXTRACTING = "extracting"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


# HuggingFace Hub は遅延インポート（依存関係の問題を避けるため）
def _get_hf_hub():
    try:
        from huggingface_hub import HfApi, hf_hub_download

        return hf_hub_download, HfApi
    except ImportError:
        logger.error("huggingface_hub is not installed. Run: pip install huggingface_hub")
        return None, None


class ModelManager:
    """
    GGUFモデルの管理

    - HuggingFace Hubからダウンロード
    - ローカルファイルの追加
    - モデル情報の取得
    - バイナリパスとログディレクトリの管理
    """

    REGISTRY_FILENAME = "registry.json"

    def __init__(
        self,
        models_dir: Path,
        binary_dir: Path | None = None,
        logs_dir: Path | None = None,
    ):
        """
        Args:
            models_dir: モデルを保存するディレクトリ (e.g., %LOCALAPPDATA%/Tepora/models)
            binary_dir: llama.cppバイナリのディレクトリ (オプション)
            logs_dir: ログディレクトリ (オプション)
        """
        self.models_dir = models_dir
        self._binary_dir = binary_dir
        self._logs_dir = logs_dir or (models_dir.parent / "logs")
        self._registry: ModelRegistry | None = None
        self._progress_callbacks: list[ProgressCallback] = []

    def _ensure_dirs(self) -> None:
        """必要なディレクトリを作成"""
        for role in ModelPool:
            (self.models_dir / role.value).mkdir(parents=True, exist_ok=True)

    def _get_registry_path(self) -> Path:
        return self.models_dir / self.REGISTRY_FILENAME

    def _load_registry(self) -> ModelRegistry:
        """レジストリをロード"""
        registry_path = self._get_registry_path()
        if registry_path.exists():
            try:
                with open(registry_path, encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                logger.warning("Failed to load model registry: %s", e, exc_info=True)
                return ModelRegistry()

            if not isinstance(data, dict):
                logger.warning(
                    "Invalid model registry format: expected object, got %s",
                    type(data).__name__,
                )
                return ModelRegistry()

            raw_models = data.get("models", [])
            if not isinstance(raw_models, list):
                logger.warning(
                    "Invalid model registry models: expected list, got %s",
                    type(raw_models).__name__,
                )
                raw_models = []

            models: list[ModelInfo] = []
            for entry in raw_models:
                if not isinstance(entry, dict):
                    logger.warning(
                        "Skipping non-dict model registry entry: %s",
                        type(entry).__name__,
                    )
                    continue
                try:
                    # 後方互換: 古いrole値を新しいプールに変換
                    role_str = entry.get("role")
                    if not role_str:
                        logger.warning(
                            "Skipping model registry entry missing role: %s",
                            entry.get("id"),
                        )
                        continue
                    role_mapping = {
                        "character": "text",
                        "executor": "text",
                    }
                    mapped_role = role_mapping.get(role_str, role_str)

                    try:
                        role = ModelPool(mapped_role)
                    except ValueError:
                        logger.warning(
                            "Skipping model registry entry with unknown role: %s", role_str
                        )
                        continue

                    model_id = entry.get("id")
                    display_name = entry.get("display_name")
                    file_path = entry.get("file_path")
                    if not model_id or not display_name or not file_path:
                        logger.warning(
                            "Skipping model registry entry with missing fields: id=%s",
                            model_id,
                        )
                        continue

                    file_size_raw = entry.get("file_size", 0)
                    try:
                        file_size = int(file_size_raw) if file_size_raw is not None else 0
                    except (TypeError, ValueError):
                        file_size = 0

                    added_at = None
                    raw_added_at = entry.get("added_at")
                    if raw_added_at:
                        try:
                            added_at = datetime.fromisoformat(raw_added_at)
                        except (TypeError, ValueError):
                            logger.warning(
                                "Invalid added_at for model %s: %s",
                                model_id,
                                raw_added_at,
                            )

                    models.append(
                        ModelInfo(
                            id=model_id,
                            display_name=display_name,
                            role=role,
                            file_path=Path(file_path),
                            file_size=file_size,
                            source=entry.get("source", "unknown"),
                            repo_id=entry.get("repo_id"),
                            filename=entry.get("filename"),
                            revision=entry.get("revision"),
                            sha256=entry.get("sha256"),
                            is_active=entry.get("is_active", False),
                            added_at=added_at,
                        )
                    )
                except Exception as exc:
                    logger.warning(
                        "Skipping invalid model registry entry: %s", exc, exc_info=True
                    )

            active = data.get("active", {})
            if not isinstance(active, dict):
                logger.warning("Invalid registry active map; resetting.")
                active = {}

            character_model_id = data.get("character_model_id")
            if character_model_id is not None and not isinstance(character_model_id, str):
                logger.warning("Invalid registry character_model_id; ignoring.")
                character_model_id = None

            executor_model_map = data.get("executor_model_map", {})
            if not isinstance(executor_model_map, dict):
                logger.warning("Invalid registry executor_model_map; resetting.")
                executor_model_map = {}

            return ModelRegistry(
                version=data.get("version", 1),
                models=models,
                active=active,
                character_model_id=character_model_id,
                executor_model_map=executor_model_map,
            )
        return ModelRegistry()

    def _save_registry(self, registry: ModelRegistry) -> None:
        """レジストリを保存"""
        self._ensure_dirs()
        registry_path = self._get_registry_path()
        data = {
            "version": registry.version,
            "models": [
                {
                    "id": m.id,
                    "display_name": m.display_name,
                    "role": m.role.value,
                    "file_path": str(m.file_path),
                    "file_size": m.file_size,
                    "source": m.source,
                    "repo_id": m.repo_id,
                    "filename": m.filename,
                    "revision": m.revision,
                    "sha256": m.sha256,
                    "is_active": m.is_active,
                    "added_at": m.added_at.isoformat() if m.added_at else None,
                }
                for m in registry.models
            ],
            "active": registry.active,
            "character_model_id": registry.character_model_id,
            "executor_model_map": registry.executor_model_map,
        }
        with open(registry_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    @property
    def registry(self) -> ModelRegistry:
        if self._registry is None:
            self._registry = self._load_registry()
        return self._registry

    def on_progress(self, callback: ProgressCallback) -> None:
        """進捗コールバックを登録"""
        self._progress_callbacks.append(callback)

    def remove_progress_callback(self, callback: ProgressCallback) -> None:
        """進捗コールバックを削除"""
        if callback in self._progress_callbacks:
            self._progress_callbacks.remove(callback)

    async def _emit_progress_async(self, event: ProgressEvent) -> None:
        """非同期コンテキストから呼ばれる進捗通知"""
        self._emit_progress(event)

    def _emit_progress(self, event: ProgressEvent) -> None:
        """進捗イベントを発火"""
        for callback in list(self._progress_callbacks):
            try:
                if asyncio.iscoroutinefunction(callback):
                    asyncio.create_task(callback(event))
                else:
                    callback(event)
            except Exception as e:
                logger.warning("Progress callback error: %s", e, exc_info=True)

    def _generate_model_id(self, display_name: str) -> str:
        """モデルIDを生成"""
        base = display_name.lower().replace(" ", "-").replace(".", "-")
        short_uuid = uuid.uuid4().hex[:8]
        return f"{base}-{short_uuid}"

    def _register_model_info(self, model_info: ModelInfo) -> None:
        """Persist a new model in the registry and set it active if needed."""
        self._registry = self.registry
        self._registry.models.append(model_info)

        if model_info.role.value not in self._registry.active:
            self._registry.active[model_info.role.value] = model_info.id
            model_info.is_active = True

        self._save_registry(self._registry)

    def _find_allowlist_entry(self, repo_id: str, filename: str) -> object | None:
        try:
            from ..config.loader import settings

            allowlist = settings.model_download.allowed
            if not allowlist:
                return None
            for entry in allowlist.values():
                entry_repo_id = _get_attr(entry, "repo_id") or _repo_id_from_url(
                    _get_attr(entry, "url")
                )
                entry_filename = _get_attr(entry, "filename")
                if entry_repo_id == repo_id and (
                    entry_filename is None or entry_filename == filename
                ):
                    # entry is an AllowedModelEntry from settings
                    result: object = entry
                    return result
            return None
        except Exception as exc:
            logger.debug("Failed to read model download allowlist: %s", exc, exc_info=True)
            return None

    def evaluate_download_policy(self, repo_id: str, filename: str) -> DownloadPolicyDecision:
        try:
            from ..config.loader import settings

            download_config = settings.model_download
        except Exception as exc:
            logger.warning(
                "Model download policy config unavailable; allowing with consent: %s",
                exc,
                exc_info=True,
            )
            # Config not available, allow with consent
            return DownloadPolicyDecision(
                allowed=True,
                requires_consent=True,
                warnings=["Configuration not available"],
                revision=None,
                expected_sha256=None,
            )

        allowlist_entry = self._find_allowlist_entry(repo_id, filename)

        warnings: list[str] = []
        revision = None
        expected_sha256 = None
        verify_sha256 = download_config.require_sha256

        if allowlist_entry:
            revision = _get_attr(allowlist_entry, "revision")
            expected_sha256 = _get_attr(allowlist_entry, "sha256")
            if expected_sha256:
                verify_sha256 = True

            if download_config.require_revision and not revision:
                return DownloadPolicyDecision(
                    allowed=False,
                    requires_consent=False,
                    warnings=["Model download blocked: revision is required but missing."],
                    revision=None,
                    expected_sha256=None,
                )

            if verify_sha256 and not expected_sha256:
                return DownloadPolicyDecision(
                    allowed=False,
                    requires_consent=False,
                    warnings=["Model download blocked: sha256 is required but missing."],
                    revision=None,
                    expected_sha256=None,
                )

            return DownloadPolicyDecision(
                allowed=True,
                requires_consent=False,
                warnings=warnings,
                revision=revision,
                expected_sha256=expected_sha256,
            )

        owner = _get_repo_owner(repo_id)
        owner_allowed = owner is not None and owner in [
            o.lower() for o in download_config.allow_repo_owners
        ]

        if owner_allowed:
            warnings.append(
                f"Model is not allowlisted. Owner '{owner}' is allowed; user consent required."
            )
            requires_consent = True
        else:
            if download_config.require_allowlist:
                return DownloadPolicyDecision(
                    allowed=False,
                    requires_consent=False,
                    warnings=["Model download blocked: model is not allowlisted."],
                    revision=None,
                    expected_sha256=None,
                )

            requires_consent = download_config.warn_on_unlisted
            if requires_consent:
                warnings.append(
                    "Model is not allowlisted or owner-approved; user consent required."
                )

        if download_config.require_revision or verify_sha256:
            metadata = _fetch_hf_file_metadata(repo_id, filename)
            if download_config.require_revision and not metadata.get("revision"):
                return DownloadPolicyDecision(
                    allowed=False,
                    requires_consent=False,
                    warnings=["Model download blocked: unable to resolve revision."],
                    revision=None,
                    expected_sha256=None,
                )
            if verify_sha256 and not metadata.get("sha256"):
                return DownloadPolicyDecision(
                    allowed=False,
                    requires_consent=False,
                    warnings=["Model download blocked: unable to resolve sha256."],
                    revision=None,
                    expected_sha256=None,
                )
            revision = metadata.get("revision")
            expected_sha256 = metadata.get("sha256") if verify_sha256 else None

        return DownloadPolicyDecision(
            allowed=True,
            requires_consent=requires_consent,
            warnings=warnings,
            revision=revision,
            expected_sha256=expected_sha256,
        )

    async def download_from_huggingface(
        self,
        repo_id: str,
        filename: str,
        role: ModelPool,
        display_name: str | None = None,
        consent_provided: bool = False,
    ) -> DownloadResult:
        """
        HuggingFace Hubからモデルをダウンロード

        Args:
            repo_id: HuggingFace repo (e.g., "unsloth/gemma-3n-E4B-it-GGUF")
            filename: ファイル名 (e.g., "gemma-3n-E4B-it-IQ4_XS.gguf")
            role: モデルの役割
            display_name: 表示名 (省略時はファイル名から生成)
        """
        self._ensure_dirs()

        if display_name is None:
            display_name = filename.replace(".gguf", "").replace("-", " ").title()

        try:
            import requests
            from huggingface_hub import hf_hub_url

            policy = self.evaluate_download_policy(repo_id, filename)
            if not policy.allowed:
                return DownloadResult(
                    success=False,
                    error_message=policy.warnings[0] if policy.warnings else "Download blocked.",
                )

            if policy.requires_consent and not consent_provided:
                return DownloadResult(
                    success=False,
                    error_message="User consent required for model download.",
                    requires_consent=True,
                    warnings=policy.warnings,
                )

            if policy.warnings:
                logger.warning(
                    "Model download consented with warnings: %s", "; ".join(policy.warnings)
                )

            revision = policy.revision
            expected_sha256 = policy.expected_sha256

            self._emit_progress(
                ProgressEvent(
                    status=DownloadStatus.PENDING,
                    progress=0.0,
                    message=f"モデル情報を取得中: {repo_id}",
                )
            )

            # URLを取得
            if revision:
                url = hf_hub_url(repo_id, filename, revision=revision)
            else:
                url = hf_hub_url(repo_id, filename)

            # ダウンロード先
            target_dir = self.models_dir / role.value
            self._ensure_dirs()
            target_path = target_dir / filename

            # 部分的なダウンロード用の一時ファイル
            temp_path = target_path.with_suffix(".tmp")

            # ストリーミングダウンロードを実行
            loop = asyncio.get_running_loop()

            def download_file():
                headers = {}
                downloaded = 0

                if temp_path.exists():
                    downloaded = temp_path.stat().st_size
                    headers["Range"] = f"bytes={downloaded}-"

                with requests.get(
                    url, stream=True, headers=headers, timeout=(10, 60)
                ) as response:
                    response.raise_for_status()

                    if downloaded > 0 and response.status_code == 200:
                        # Range not honored; restart from scratch.
                        downloaded = 0
                        try:
                            temp_path.unlink(missing_ok=True)
                        except Exception as exc:
                            logger.warning(
                                "Failed to reset partial download for %s: %s",
                                filename,
                                exc,
                                exc_info=True,
                            )

                    total_size = int(response.headers.get("content-length", 0)) + downloaded

                    mode = "ab" if downloaded > 0 else "wb"
                    with open(temp_path, mode) as f:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)
                                downloaded += len(chunk)

                                if total_size > 0:
                                    progress = downloaded / total_size
                                    asyncio.run_coroutine_threadsafe(
                                        self._emit_progress_async(
                                            ProgressEvent(
                                                status=DownloadStatus.DOWNLOADING,
                                                progress=progress,
                                                message=f"ダウンロード中: {filename} ({downloaded / 1024 / 1024:.1f}MB / {total_size / 1024 / 1024:.1f}MB)",
                                                total_bytes=total_size,
                                                current_bytes=downloaded,
                                            )
                                        ),
                                        loop,
                                    )

                if temp_path.exists():
                    shutil.move(temp_path, target_path)

                return target_path

            await loop.run_in_executor(None, download_file)

            downloaded_path = target_path
            actual_size = downloaded_path.stat().st_size if downloaded_path.exists() else 0

            actual_sha256 = None
            if expected_sha256:
                actual_sha256 = _sha256_file(downloaded_path)
                if actual_sha256.lower() != expected_sha256.lower():
                    try:
                        downloaded_path.unlink()
                    except Exception as cleanup_error:
                        logger.warning(
                            "Failed to remove model with mismatched sha256: %s",
                            cleanup_error,
                            exc_info=True,
                        )
                    raise ValueError("sha256 mismatch for downloaded model.")

            # レジストリに追加
            model_id = self._generate_model_id(display_name)
            model_info = ModelInfo(
                id=model_id,
                display_name=display_name,
                role=role,
                file_path=downloaded_path,
                file_size=actual_size,
                source="huggingface",
                repo_id=repo_id,
                filename=filename,
                revision=revision,
                sha256=actual_sha256,
                is_active=False,
                added_at=datetime.now(),
            )

            self._register_model_info(model_info)

            self._emit_progress(
                ProgressEvent(
                    status=DownloadStatus.COMPLETED,
                    progress=1.0,
                    message="ダウンロード完了",
                )
            )

            return DownloadResult(
                success=True,
                path=downloaded_path,
            )

        except Exception as e:
            logger.error(f"Failed to download model: {e}", exc_info=True)
            self._emit_progress(
                ProgressEvent(
                    status=DownloadStatus.FAILED,
                    progress=0.0,
                    message=f"エラー: {str(e)}",
                )
            )
            return DownloadResult(
                success=False,
                error_message=str(e),
            )

    def check_huggingface_update(
        self,
        repo_id: str,
        filename: str,
        *,
        current_revision: str | None = None,
        current_sha256: str | None = None,
        current_path: Path | None = None,
    ) -> dict:
        """Check if a newer revision exists on HuggingFace for the given model file."""
        metadata = _fetch_hf_file_metadata(repo_id, filename)
        latest_revision = metadata.get("revision")
        latest_sha256 = metadata.get("sha256")

        resolved_current_sha256 = current_sha256
        if (
            not resolved_current_sha256
            and current_path
            and current_path.exists()
            and latest_sha256
        ):
            try:
                resolved_current_sha256 = _sha256_file(current_path)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to compute local sha256 for update check: %s",
                    exc,
                    exc_info=True,
                )

        update_available = False
        reason = "unknown"

        if current_revision and latest_revision:
            update_available = current_revision != latest_revision
            reason = "revision_mismatch" if update_available else "up_to_date"
        elif resolved_current_sha256 and latest_sha256:
            update_available = resolved_current_sha256.lower() != latest_sha256.lower()
            reason = "sha256_mismatch" if update_available else "up_to_date"
        else:
            reason = "insufficient_data"

        return {
            "update_available": update_available,
            "reason": reason,
            "current_revision": current_revision,
            "latest_revision": latest_revision,
            "current_sha256": resolved_current_sha256,
            "latest_sha256": latest_sha256,
        }

    async def add_local_model(
        self,
        file_path: Path,
        role: ModelPool,
        display_name: str,
        copy_to_models_dir: bool = True,
    ) -> bool:
        """ローカルのGGUFファイルを追加"""
        self._ensure_dirs()

        if not file_path.exists():
            logger.error(f"File not found: {file_path}")
            return False

        if file_path.suffix.lower() != ".gguf":
            logger.error(f"Not a GGUF file: {file_path}")
            return False

        try:
            target_path = file_path

            if copy_to_models_dir:
                target_dir = self.models_dir / role.value
                target_path = target_dir / file_path.name

                if target_path.exists() and target_path != file_path:
                    logger.warning(f"File already exists: {target_path}")
                else:
                    shutil.copy2(file_path, target_path)

            file_size = target_path.stat().st_size

            model_id = self._generate_model_id(display_name)
            model_info = ModelInfo(
                id=model_id,
                display_name=display_name,
                role=role,
                file_path=target_path,
                file_size=file_size,
                source="local",
                is_active=False,
                added_at=datetime.now(),
            )

            self._register_model_info(model_info)

            logger.info(f"Added local model: {display_name} ({model_id})")
            return True

        except Exception as e:
            logger.error(f"Failed to add local model: {e}", exc_info=True)
            return False

    # Alias for compatibility with API
    async def register_local_model(
        self,
        file_path: Path,
        role: ModelPool,
        display_name: str,
        copy_to_models_dir: bool = True,
    ) -> bool:
        """ローカルモデルを登録（add_local_modelのエイリアス）"""
        return await self.add_local_model(file_path, role, display_name, copy_to_models_dir)

    def get_available_models(self, role: ModelPool | None = None) -> list[ModelInfo]:
        """利用可能なモデル一覧を取得"""
        models = self.registry.models
        if role:
            models = [m for m in models if m.role == role]
        return models

    def get_active_model(self, role: ModelPool) -> ModelInfo | None:
        """現在アクティブなモデルを取得"""
        active_id = self.registry.active.get(role.value)
        if active_id:
            for m in self.registry.models:
                if m.id == active_id:
                    return m
        return None

    async def set_active_model(self, role: ModelPool, model_id: str) -> bool:
        """指定ロールのアクティブモデルを設定"""
        found = False
        for m in self.registry.models:
            if m.id == model_id and m.role == role:
                found = True
                break

        if not found:
            logger.error(f"Model not found: {model_id}")
            return False

        self._registry = self.registry
        self._registry.active[role.value] = model_id

        for m in self._registry.models:
            if m.role == role:
                m.is_active = m.id == model_id

        self._save_registry(self._registry)
        logger.info(f"Set active model for {role.value}: {model_id}")
        return True

    async def delete_model(self, model_id: str) -> bool:
        """モデルを削除"""
        self._registry = self.registry

        model_to_delete = None
        for m in self._registry.models:
            if m.id == model_id:
                model_to_delete = m
                break

        if not model_to_delete:
            logger.error(f"Model not found: {model_id}")
            return False

        if model_to_delete.file_path.is_relative_to(self.models_dir):
            try:
                model_to_delete.file_path.unlink()
            except Exception as e:
                logger.warning("Failed to delete model file: %s", e, exc_info=True)

        self._registry.models = [m for m in self._registry.models if m.id != model_id]

        role = model_to_delete.role
        if self._registry.active.get(role.value) == model_id:
            alternatives = [m for m in self._registry.models if m.role == role]
            if alternatives:
                self._registry.active[role.value] = alternatives[0].id
                alternatives[0].is_active = True
            else:
                del self._registry.active[role.value]

        self._save_registry(self._registry)
        logger.info(f"Deleted model: {model_id}")
        return True

    def get_model_path(self, role: ModelPool) -> Path | None:
        """指定ロールのアクティブモデルのパスを取得"""
        model = self.get_active_model(role)
        if model and model.file_path.exists():
            return model.file_path
        return None

    def has_required_models(self) -> bool:
        """必須モデル（text, embedding）がすべて揃っているか"""
        for pool in [ModelPool.TEXT, ModelPool.EMBEDDING]:
            if not self.get_active_model(pool):
                return False
        return True

    def reorder_models(self, role: ModelPool, new_order_ids: list[str]) -> bool:
        """モデルの表示順序を更新"""
        self._registry = self.registry

        role_models = [m for m in self._registry.models if m.role == role]
        other_models = [m for m in self._registry.models if m.role != role]

        model_map = {m.id: m for m in role_models}

        new_role_models = []
        for mid in new_order_ids:
            if mid in model_map:
                new_role_models.append(model_map[mid])
            else:
                logger.warning(f"Model ID {mid} not found in registry during reorder")

        existing_ids = set(new_order_ids)
        for m in role_models:
            if m.id not in existing_ids:
                new_role_models.append(m)

        self._registry.models = other_models + new_role_models
        self._save_registry(self._registry)
        return True

    async def check_huggingface_repo(self, repo_id: str, filename: str) -> bool:
        """HuggingFace Hubにファイルが存在するか確認"""
        try:
            import requests
            from huggingface_hub import hf_hub_url

            url = hf_hub_url(repo_id, filename)
            response = requests.head(url, allow_redirects=True, timeout=10)
            return bool(response.status_code == 200)
        except Exception as e:
            logger.warning("Failed to check HuggingFace repo: %s", e, exc_info=True)
            return False

    # ========================================================================
    # ロールベースモデル選択 (Character / Executor)
    # ========================================================================

    def get_character_model_id(self) -> str | None:
        """キャラクターモデルのIDを取得"""
        return self.registry.character_model_id

    def get_executor_model_id(self, task_type: str = "default") -> str | None:
        """エグゼキューターモデルのIDを取得"""
        executor_map = self.registry.executor_model_map
        if task_type in executor_map:
            result_val = executor_map[task_type]
            return str(result_val) if result_val else None
        result = executor_map.get("default")
        return str(result) if result else None

    def set_character_model(self, model_id: str) -> bool:
        """キャラクターモデルを設定"""
        found = any(
            m.id == model_id and m.role == ModelPool.TEXT for m in self.registry.models
        )
        if not found:
            logger.error(f"Model {model_id} not found in TEXT pool")
            return False

        self._registry = self.registry
        self._registry.character_model_id = model_id
        self._save_registry(self._registry)
        logger.info(f"Set character model: {model_id}")
        return True

    def set_executor_model(self, task_type: str, model_id: str) -> bool:
        """エグゼキューターモデルを設定"""
        found = any(
            m.id == model_id and m.role == ModelPool.TEXT for m in self.registry.models
        )
        if not found:
            logger.error(f"Model {model_id} not found in TEXT pool")
            return False

        self._registry = self.registry
        self._registry.executor_model_map[task_type] = model_id
        self._save_registry(self._registry)
        logger.info(f"Set executor model for '{task_type}': {model_id}")
        return True

    def remove_executor_model(self, task_type: str) -> bool:
        """エグゼキューターモデルのマッピングを削除"""
        if task_type == "default":
            logger.error("Cannot remove 'default' executor model mapping")
            return False

        self._registry = self.registry
        if task_type in self._registry.executor_model_map:
            del self._registry.executor_model_map[task_type]
            self._save_registry(self._registry)
            logger.info(f"Removed executor model mapping for '{task_type}'")
            return True
        return False

    def get_executor_task_types(self) -> list[str]:
        """設定済みのエグゼキュータータスクタイプ一覧を取得"""
        return list(self.registry.executor_model_map.keys())

    def get_character_model_path(self) -> Path | None:
        """キャラクターモデルのパスを取得"""
        model_id = self.get_character_model_id()
        if not model_id:
            return None
        for m in self.registry.models:
            if m.id == model_id and m.file_path.exists():
                return m.file_path
        return None

    def get_executor_model_path(self, task_type: str = "default") -> Path | None:
        """エグゼキューターモデルのパスを取得"""
        model_id = self.get_executor_model_id(task_type)
        if not model_id:
            return None
        for m in self.registry.models:
            if m.id == model_id and m.file_path.exists():
                return m.file_path
        return None

    # ========================================================================
    # Binary and Logs Directory Access
    # ========================================================================

    def get_binary_path(self) -> Path | None:
        """llama.cppバイナリのパスを取得"""
        if not self._binary_dir:
            return None

        from ..llm import find_server_executable

        return find_server_executable(self._binary_dir)

    def get_logs_dir(self) -> Path:
        """ログディレクトリを取得"""
        self._logs_dir.mkdir(parents=True, exist_ok=True)
        return self._logs_dir
