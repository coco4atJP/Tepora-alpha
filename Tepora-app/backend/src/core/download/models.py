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

from ..config.loader import settings
from .types import (
    DownloadResult,
    DownloadStatus,
    ModelInfo,
    ModelRegistry,
    ModelRole,
    ProgressCallback,
    ProgressEvent,
)

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


def _get_entry_value(entry: object, key: str) -> str | None:
    if entry is None:
        return None
    if isinstance(entry, dict):
        return entry.get(key)
    return getattr(entry, key, None)


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
        return _get_attr(lfs, "sha256") or _get_attr(lfs, "sha")
    return _get_attr(file_info, "oid") or _get_attr(file_info, "blob_id")


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
        logger.warning("Failed to fetch HuggingFace metadata: %s", exc)
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
    """

    REGISTRY_FILENAME = "registry.json"

    def __init__(self, models_dir: Path):
        """
        Args:
            models_dir: モデルを保存するディレクトリ (e.g., %LOCALAPPDATA%/Tepora/models)
        """
        self.models_dir = models_dir
        self._registry: ModelRegistry | None = None
        self._progress_callbacks: list[ProgressCallback] = []

    def _ensure_dirs(self) -> None:
        """必要なディレクトリを作成"""
        for role in ModelRole:
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
                    models = []
                    for m in data.get("models", []):
                        # 後方互換: 古いrole値を新しいプールに変換
                        role_str = m["role"]
                        role_mapping = {
                            "character": "text",
                            "executor": "text",
                        }
                        mapped_role = role_mapping.get(role_str, role_str)

                        models.append(
                            ModelInfo(
                                id=m["id"],
                                display_name=m["display_name"],
                                role=ModelRole(mapped_role),
                                file_path=Path(m["file_path"]),
                                file_size=m["file_size"],
                                source=m["source"],
                                repo_id=m.get("repo_id"),
                                filename=m.get("filename"),
                                revision=m.get("revision"),
                                sha256=m.get("sha256"),
                                is_active=m.get("is_active", False),
                                added_at=datetime.fromisoformat(m["added_at"])
                                if m.get("added_at")
                                else None,
                            )
                        )
                    return ModelRegistry(
                        version=data.get("version", 1),
                        models=models,
                        active=data.get("active", {}),
                        character_model_id=data.get("character_model_id"),
                        executor_model_map=data.get("executor_model_map", {}),
                    )
            except Exception as e:
                logger.warning(f"Failed to load model registry: {e}")
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
        for callback in self._progress_callbacks:
            try:
                if asyncio.iscoroutinefunction(callback):
                    # コールバックが非同期関数の場合は、現在のループでタスクとして実行
                    # 注意: ここは同期関数なので、create_taskはループが走っている前提
                    asyncio.create_task(callback(event))
                else:
                    callback(event)
            except Exception as e:
                logger.warning(f"Progress callback error: {e}")

    def _generate_model_id(self, display_name: str) -> str:
        """モデルIDを生成"""
        # 表示名をスラッグ化し、衝突を避けるためにUUIDの一部を追加
        base = display_name.lower().replace(" ", "-").replace(".", "-")
        short_uuid = uuid.uuid4().hex[:8]
        return f"{base}-{short_uuid}"

    def _find_allowlist_entry(self, repo_id: str, filename: str) -> object | None:
        allowlist = settings.model_download.allowed
        if not allowlist:
            return None
        for entry in allowlist.values():
            entry_repo_id = _get_entry_value(entry, "repo_id") or _repo_id_from_url(
                _get_entry_value(entry, "url")
            )
            entry_filename = _get_entry_value(entry, "filename")
            if entry_repo_id == repo_id and (entry_filename is None or entry_filename == filename):
                return entry
        return None

    def evaluate_download_policy(self, repo_id: str, filename: str) -> DownloadPolicyDecision:
        download_config = settings.model_download
        allowlist_entry = self._find_allowlist_entry(repo_id, filename)

        warnings: list[str] = []
        revision = None
        expected_sha256 = None
        verify_sha256 = download_config.require_sha256

        if allowlist_entry:
            revision = _get_entry_value(allowlist_entry, "revision")
            expected_sha256 = _get_entry_value(allowlist_entry, "sha256")
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
        owner_allowed = (
            owner is not None and owner in [o.lower() for o in download_config.allow_repo_owners]
        )

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
        role: ModelRole,
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
            loop = asyncio.get_event_loop()

            def download_file():
                headers = {}
                downloaded = 0

                # 既存の一時ファイルがあればレジュームを試みる
                if temp_path.exists():
                    downloaded = temp_path.stat().st_size
                    headers["Range"] = f"bytes={downloaded}-"

                with requests.get(url, stream=True, headers=headers) as response:
                    response.raise_for_status()

                    total_size = int(response.headers.get("content-length", 0)) + downloaded

                    mode = "ab" if downloaded > 0 else "wb"
                    with open(temp_path, mode) as f:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)
                                downloaded += len(chunk)

                                # 進捗コールバック（非同期イベントループにスケジュール）
                                if total_size > 0:
                                    progress = downloaded / total_size
                                    # 注意: ここは同期コンテキストなので、外部からポーリングされる変数などを更新するか
                                    # あるいはスレッドセーフな方法でイベントを送る必要がある
                                    # 簡易的に、DownloadManager側で定期的にファイルサイズをチェックするか、
                                    # ここでは非同期コールバックを直接呼び出せないので、
                                    # シンプルに実装するためにブロッキング呼び出しの中で進捗を計算し
                                    # 戻り値として返すことはできない。
                                    # run_in_executorを使うため、ここでasyncio.run_coroutine_threadsafeを使う
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

                # 完了したらリネーム
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

            self._registry = self.registry
            self._registry.models.append(model_info)

            # このロールにアクティブなモデルがなければ、これをアクティブに
            if role.value not in self._registry.active:
                self._registry.active[role.value] = model_id
                model_info.is_active = True

            self._save_registry(self._registry)

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
        """
        Check if a newer revision exists on HuggingFace for the given model file.
        """
        metadata = _fetch_hf_file_metadata(repo_id, filename)
        latest_revision = metadata.get("revision")
        latest_sha256 = metadata.get("sha256")

        resolved_current_sha256 = current_sha256
        if not resolved_current_sha256 and current_path and current_path.exists() and latest_sha256:
            try:
                resolved_current_sha256 = _sha256_file(current_path)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to compute local sha256 for update check: %s", exc)

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
        role: ModelRole,
        display_name: str,
        copy_to_models_dir: bool = True,
    ) -> bool:
        """
        ローカルのGGUFファイルを追加（ファイル選択またはドラッグ&ドロップ）

        Args:
            file_path: GGUFファイルのパス
            role: モデルの役割
            display_name: 表示名
            copy_to_models_dir: Trueの場合コピー、Falseの場合は元のパスを参照
        """
        self._ensure_dirs()

        if not file_path.exists():
            logger.error(f"File not found: {file_path}")
            return False

        if not file_path.suffix.lower() == ".gguf":
            logger.error(f"Not a GGUF file: {file_path}")
            return False

        try:
            target_path = file_path

            if copy_to_models_dir:
                target_dir = self.models_dir / role.value
                target_path = target_dir / file_path.name

                if target_path.exists() and target_path != file_path:
                    # 既に存在する場合は上書き確認（ここではスキップ）
                    logger.warning(f"File already exists: {target_path}")
                else:
                    shutil.copy2(file_path, target_path)

            file_size = target_path.stat().st_size

            # レジストリに追加
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

            self._registry = self.registry
            self._registry.models.append(model_info)

            # このロールにアクティブなモデルがなければ、これをアクティブに
            if role.value not in self._registry.active:
                self._registry.active[role.value] = model_id
                model_info.is_active = True

            self._save_registry(self._registry)

            logger.info(f"Added local model: {display_name} ({model_id})")
            return True

        except Exception as e:
            logger.error(f"Failed to add local model: {e}", exc_info=True)
            return False

    def get_available_models(self, role: ModelRole | None = None) -> list[ModelInfo]:
        """利用可能なモデル一覧を取得"""
        models = self.registry.models
        if role:
            models = [m for m in models if m.role == role]
        return models

    def get_active_model(self, role: ModelRole) -> ModelInfo | None:
        """現在アクティブなモデルを取得"""
        active_id = self.registry.active.get(role.value)
        if active_id:
            for m in self.registry.models:
                if m.id == active_id:
                    return m
        return None

    async def set_active_model(self, role: ModelRole, model_id: str) -> bool:
        """指定ロールのアクティブモデルを設定"""
        # モデルが存在するか確認
        found = False
        for m in self.registry.models:
            if m.id == model_id and m.role == role:
                found = True
                break

        if not found:
            logger.error(f"Model not found: {model_id}")
            return False

        # アクティブ状態を更新
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

        # ファイルを削除（modelsディレクトリ内の場合のみ）
        if model_to_delete.file_path.is_relative_to(self.models_dir):
            try:
                model_to_delete.file_path.unlink()
            except Exception as e:
                logger.warning(f"Failed to delete model file: {e}")

        # レジストリから削除
        self._registry.models = [m for m in self._registry.models if m.id != model_id]

        # アクティブだった場合は解除
        role = model_to_delete.role
        if self._registry.active.get(role.value) == model_id:
            # 同じロールの別のモデルがあればそれをアクティブに
            alternatives = [m for m in self._registry.models if m.role == role]
            if alternatives:
                self._registry.active[role.value] = alternatives[0].id
                alternatives[0].is_active = True
            else:
                del self._registry.active[role.value]

        self._save_registry(self._registry)
        logger.info(f"Deleted model: {model_id}")
        return True

    def get_model_path(self, role: ModelRole) -> Path | None:
        """指定ロールのアクティブモデルのパスを取得"""
        model = self.get_active_model(role)
        if model and model.file_path.exists():
            return model.file_path
        return None

    def has_required_models(self) -> bool:
        """必須モデル（text, embedding）がすべて揃っているか"""
        from .types import ModelPool

        for pool in [ModelPool.TEXT, ModelPool.EMBEDDING]:
            if not self.get_active_model(pool):
                return False
        return True

    def reorder_models(self, role: ModelRole, new_order_ids: list[str]) -> bool:
        """
        モデルの表示順序を更新

        Args:
            role: 対象のロール
            new_order_ids: モデルIDのリスト（保存したい順序）
        """
        self._registry = self.registry

        # 指定ロールのモデルを抽出
        role_models = [m for m in self._registry.models if m.role == role]
        other_models = [m for m in self._registry.models if m.role != role]

        # IDでマップを作成
        model_map = {m.id: m for m in role_models}

        # 新しい順序でリストを作成
        new_role_models = []
        for mid in new_order_ids:
            if mid in model_map:
                new_role_models.append(model_map[mid])
            else:
                logger.warning(f"Model ID {mid} not found in registry during reorder")

        # リストに含まれていないモデル（もしあれば）を末尾に追加
        existing_ids = set(new_order_ids)
        for m in role_models:
            if m.id not in existing_ids:
                new_role_models.append(m)

        # レジストリを更新
        # 元のリストでの相対的な位置関係を保つために、単純結合ではなく少し慎重にやる必要があるが
        # ここではシンプルに「他ロール」+「並び替えた自ロール」とする
        # ただし、元のリストの順序に依存しないように、常にロールごとにグルーピングされる副作用があるかもしれない
        # User requirement implies just reordering within the list visible in UI.

        self._registry.models = other_models + new_role_models
        self._save_registry(self._registry)
        return True

    async def check_huggingface_repo(self, repo_id: str, filename: str) -> bool:
        """
        HuggingFace Hubにファイルが存在するか確認
        """
        try:
            import requests
            from huggingface_hub import hf_hub_url

            url = hf_hub_url(repo_id, filename)
            # HEADリクエストで存在確認
            response = requests.head(url, allow_redirects=True, timeout=10)
            return response.status_code == 200
        except Exception as e:
            logger.warning(f"Failed to check HuggingFace repo: {e}")
            return False

    # ========================================================================
    # ロールベースモデル選択 (Character / Executor)
    # ========================================================================

    def get_character_model_id(self) -> str | None:
        """キャラクターモデルのIDを取得"""
        return self.registry.character_model_id

    def get_executor_model_id(self, task_type: str = "default") -> str | None:
        """
        エグゼキューターモデルのIDを取得

        Args:
            task_type: タスクタイプ (e.g., "default", "coding", "browser")

        Returns:
            モデルID。見つからない場合は "default" にフォールバック
        """
        executor_map = self.registry.executor_model_map
        if task_type in executor_map:
            return executor_map[task_type]
        # フォールバック: default
        return executor_map.get("default")

    def set_character_model(self, model_id: str) -> bool:
        """キャラクターモデルを設定"""
        # モデルがTEXTプールに存在するか確認
        from .types import ModelPool

        found = any(m.id == model_id and m.role == ModelPool.TEXT for m in self.registry.models)
        if not found:
            logger.error(f"Model {model_id} not found in TEXT pool")
            return False

        self._registry = self.registry
        self._registry.character_model_id = model_id
        self._save_registry(self._registry)
        logger.info(f"Set character model: {model_id}")
        return True

    def set_executor_model(self, task_type: str, model_id: str) -> bool:
        """
        エグゼキューターモデルを設定

        Args:
            task_type: タスクタイプ (e.g., "default", "coding", "browser")
            model_id: モデルID
        """
        # モデルがTEXTプールに存在するか確認
        from .types import ModelPool

        found = any(m.id == model_id and m.role == ModelPool.TEXT for m in self.registry.models)
        if not found:
            logger.error(f"Model {model_id} not found in TEXT pool")
            return False

        self._registry = self.registry
        self._registry.executor_model_map[task_type] = model_id
        self._save_registry(self._registry)
        logger.info(f"Set executor model for '{task_type}': {model_id}")
        return True

    def remove_executor_model(self, task_type: str) -> bool:
        """
        エグゼキューターモデルのマッピングを削除

        Args:
            task_type: 削除するタスクタイプ（"default"は削除不可）
        """
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
