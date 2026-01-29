"""
Model Manager - GGUFモデルの管理

機能:
- HuggingFace Hubからダウンロード
- ローカルファイルの追加
- モデル情報の取得
- アクティブモデルの管理
"""

import asyncio
import hashlib
import json
import logging
import os
import shutil
import tempfile
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Any
from urllib.parse import urlparse

from ..llm.ollama_runner import OllamaRunner
from .types import (
    ModelConfig,
    ModelInfo,
    ModelLoader,
    ModelModality,
    ModelRegistry,
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


@dataclass
class LocalModelRegistrationResult:
    """ローカルモデル登録結果"""

    success: bool
    model_id: str | None = None
    error_message: str | None = None


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
    モデル管理クラス (V3)

    機能:
    - IDベースのモデル管理
    - ロールベースの割り当て (character, executor, etc.)
    - llama.cpp / ollama (将来) のローダー管理
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
            models_dir: モデルを保存するディレクトリ
            binary_dir: user for llama.cpp binary lookup
            logs_dir: log directory
        """
        self.models_dir = models_dir
        self._binary_dir = binary_dir
        self._logs_dir = logs_dir or (models_dir.parent / "logs")
        self._registry: ModelRegistry | None = None
        self._registry_mtime: float | None = None
        self._progress_callbacks: list[ProgressCallback] = []
        self._registry_lock = RLock()

    @staticmethod
    def _coerce_modality(value: Any | None) -> ModelModality:
        """
        Accept legacy "role/pool" values and normalize them to ModelModality.

        - ModelModality -> as-is
        - Enum with .value -> use the value
        - strings like "text"/"embedding"/"character"/"executor"
        """
        if value is None:
            return ModelModality.TEXT
        if isinstance(value, ModelModality):
            return value

        raw = getattr(value, "value", value)
        normalized = str(raw).strip().lower()
        if normalized in {"character", "professional", "executor"}:
            normalized = "text"

        try:
            return ModelModality(normalized)
        except ValueError:
            return ModelModality.TEXT

    def _ensure_dirs(self) -> None:
        """必要なディレクトリを作成"""
        # モダリティごとのフォルダは作成しない方針に変更（もしくはフラットに管理、あるいは任意）
        # しかし後方互換でテキストモデルなどが整理されている方が見やすいかもしれない
        # V3では models_dir 直下配置を基本としつつ、サブディレクトリも許容する
        if not self.models_dir.exists():
            self.models_dir.mkdir(parents=True, exist_ok=True)

        # 既存構造維持のためにサブディレクトリも作っておく
        for m in ModelModality:
            (self.models_dir / m.value).mkdir(exist_ok=True)

    def _get_registry_path(self) -> Path:
        return self.models_dir / self.REGISTRY_FILENAME

    def _get_registry_mtime(self) -> float | None:
        registry_path = self._get_registry_path()
        try:
            return registry_path.stat().st_mtime
        except FileNotFoundError:
            return None
        except Exception:
            logger.debug("Failed to stat model registry", exc_info=True)
            return None

    def _load_registry(self) -> ModelRegistry:
        """レジストリをロード (V2 -> V3 Migration含む)"""
        registry_path = self._get_registry_path()
        self._registry_mtime = self._get_registry_mtime()

        if not registry_path.exists():
            return ModelRegistry()

        try:
            with open(registry_path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            logger.warning("Failed to load model registry: %s", e, exc_info=True)
            return ModelRegistry()

        version = data.get("version", 1)

        if version < 3:
            logger.info("Migrating model registry from version %s to 3", version)
            return self._migrate_registry_v2_to_v3(data)

        # V3 Load Logic
        models: list[ModelInfo] = []
        for entry in data.get("models", []):
            try:
                # Parse Enums
                try:
                    loader = ModelLoader(entry.get("loader", "llama_cpp"))
                except ValueError:
                    loader = ModelLoader.LLAMA_CPP

                try:
                    modality = ModelModality(entry.get("modality", "text"))
                except ValueError:
                    modality = ModelModality.TEXT

                # Parse Config
                cfg_data = entry.get("config", {})
                config = ModelConfig(
                    n_ctx=cfg_data.get("n_ctx", 8192),
                    n_gpu_layers=cfg_data.get("n_gpu_layers", -1),
                    temperature=cfg_data.get("temperature", 0.7),
                    top_p=cfg_data.get("top_p", 0.9),
                    top_k=cfg_data.get("top_k", 40),
                    repeat_penalty=cfg_data.get("repeat_penalty", 1.1),
                    logprobs=cfg_data.get("logprobs", True),
                    extra_args=cfg_data.get("extra_args", []),
                )

                added_at = None
                if entry.get("added_at"):
                    try:
                        added_at = datetime.fromisoformat(entry.get("added_at"))
                    except ValueError:
                        pass

                models.append(
                    ModelInfo(
                        id=entry["id"],
                        name=entry.get("name") or entry.get("display_name") or "Unknown Model",
                        loader=loader,
                        path=entry["path"],
                        modality=modality,
                        description=entry.get("description"),
                        source=entry.get("source"),
                        repo_id=entry.get("repo_id"),
                        filename=entry.get("filename"),
                        revision=entry.get("revision"),
                        sha256=entry.get("sha256"),
                        size_bytes=entry.get("size_bytes", 0),
                        added_at=added_at,
                        config=config,
                    )
                )
            except Exception as e:
                logger.warning("Skipping invalid v3 model entry: %s (%s)", entry.get("id"), e)

        return ModelRegistry(version=3, models=models, roles=data.get("roles", {}))

    def _migrate_registry_v2_to_v3(self, data: dict) -> ModelRegistry:
        """V2 Data -> V3 Registry Migration"""
        models: list[ModelInfo] = []
        roles: dict[str, str] = {}

        for entry in data.get("models", []):
            try:
                # Map Role -> Modality
                old_role = entry.get("role", "text")
                modality = ModelModality.TEXT
                if old_role == "embedding":
                    modality = ModelModality.EMBEDDING

                model_id = entry.get("id")
                if not model_id:
                    continue

                added_at = None
                if entry.get("added_at"):
                    try:
                        added_at = datetime.fromisoformat(entry.get("added_at"))
                    except ValueError:
                        pass

                path = entry.get("file_path")
                if not path:
                    continue

                models.append(
                    ModelInfo(
                        id=model_id,
                        name=entry.get("display_name", "Unknown"),
                        loader=ModelLoader.LLAMA_CPP,  # Default V2 models are llama.cpp
                        path=path,
                        modality=modality,
                        source=entry.get("source"),
                        repo_id=entry.get("repo_id"),
                        filename=entry.get("filename"),
                        revision=entry.get("revision"),
                        sha256=entry.get("sha256"),
                        size_bytes=entry.get("file_size", 0),
                        added_at=added_at,
                        config=ModelConfig(),  # Default config
                    )
                )
            except Exception:
                logger.warning("Migration failed for entry: %s", entry)

        # character_model_id
        char_id = data.get("character_model_id")
        if char_id:
            roles["character"] = char_id

        # executor_model_map -> roles (Migrate to professional role)
        exec_map = data.get("executor_model_map", {})
        for task, mid in exec_map.items():
            if task == "default":
                roles["professional"] = mid
            else:
                roles[f"professional:{task}"] = mid

        # active map (V2 legacy active concept)
        active_map = data.get("active", {})
        if "text" in active_map and "character" not in roles:
            roles["character"] = active_map["text"]
        if "embedding" in active_map:
            roles["embedding"] = active_map["embedding"]

        # Verify IDs exist
        valid_ids = {m.id for m in models}
        clean_roles = {k: v for k, v in roles.items() if v in valid_ids}

        logger.info("Migration completed. %d models, %d roles.", len(models), len(clean_roles))
        return ModelRegistry(version=3, models=models, roles=clean_roles)

    def _save_registry(self, registry: ModelRegistry) -> None:
        """レジストリを保存 (V3 format)"""
        with self._registry_lock:
            self._ensure_dirs()
            registry_path = self._get_registry_path()

            models_data = []
            for m in registry.models:
                models_data.append(
                    {
                        "id": m.id,
                        "name": m.name,
                        "loader": m.loader.value,
                        "path": m.path,
                        "modality": m.modality.value,
                        "description": m.description,
                        "source": m.source,
                        "repo_id": m.repo_id,
                        "filename": m.filename,
                        "revision": m.revision,
                        "sha256": m.sha256,
                        "size_bytes": m.size_bytes,
                        "added_at": m.added_at.isoformat() if m.added_at else None,
                        "config": asdict(m.config),
                    }
                )

            data = {"version": 3, "models": models_data, "roles": registry.roles}

            tmp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w", encoding="utf-8", dir=registry_path.parent, delete=False
                ) as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                    f.flush()
                    os.fsync(f.fileno())
                    tmp_path = Path(f.name)
                os.replace(tmp_path, registry_path)
            finally:
                if tmp_path and tmp_path.exists() and tmp_path != registry_path:
                    tmp_path.unlink(missing_ok=True)

            self._registry_mtime = self._get_registry_mtime()

    @property
    def registry(self) -> ModelRegistry:
        with self._registry_lock:
            current_mtime = self._get_registry_mtime()
            if self._registry is None or (
                self._registry_mtime and current_mtime != self._registry_mtime
            ):
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

    def _generate_model_id(self, name: str) -> str:
        """モデルIDを生成 (name-uuid)"""
        base = name.lower().replace(" ", "-").replace(".", "-")[:20]
        short_uuid = uuid.uuid4().hex[:8]
        return f"{base}-{short_uuid}"

    def _register_model_info(self, model_info: ModelInfo) -> None:
        """Persist a new model in the registry."""
        with self._registry_lock:
            self._registry = self.registry  # ensure loaded

            # Update in-place if same ID exists (preserve ordering)
            for idx, existing in enumerate(self._registry.models):
                if existing.id == model_info.id:
                    self._registry.models[idx] = model_info
                    break
            else:
                self._registry.models.append(model_info)

            # Auto-assign roles if first of its kind
            if model_info.modality == ModelModality.TEXT:
                if "character" not in self._registry.roles:
                    self._registry.roles["character"] = model_info.id
                    logger.info("Auto-assigned 'character' role to %s", model_info.id)

            elif model_info.modality == ModelModality.EMBEDDING:
                if "embedding" not in self._registry.roles:
                    self._registry.roles["embedding"] = model_info.id
                    logger.info("Auto-assigned 'embedding' role to %s", model_info.id)

            self._save_registry(self._registry)

    # -------------------------------------------------------------------------
    # Public Model Management API
    # -------------------------------------------------------------------------

    def get_available_models(self) -> list[ModelInfo]:
        """Return models in the registry order (V3)."""
        return list(self.registry.models)

    def get_model(self, model_id: str) -> ModelInfo | None:
        """Get model info by ID"""
        for m in self.registry.models:
            if m.id == model_id:
                return m
        return None

    def get_assigned_model_id(self, role: str) -> str | None:
        """Get model ID assigned to a role"""
        return self.registry.roles.get(role)

    def set_role_model(self, role: str, model_id: str) -> bool:
        """Assign a model to a role"""
        model = self.get_model(model_id)
        if not model:
            logger.error("Model ID %s not found", model_id)
            return False
        with self._registry_lock:
            self._registry = self.registry
            self._registry.roles[role] = model_id
            self._save_registry(self._registry)
            logger.info("Assigned role '%s' to model %s", role, model_id)
            return True

    def remove_role_assignment(self, role: str) -> bool:
        """Remove a role assignment"""
        with self._registry_lock:
            self._registry = self.registry
            if role in self._registry.roles:
                del self._registry.roles[role]
                self._save_registry(self._registry)
                logger.info("Removed role assignment '%s'", role)
                return True
            return False

    def get_active_model(self, pool: Any) -> ModelInfo | None:
        """Legacy helper: return the "active" model for a pool."""
        modality = self._coerce_modality(pool)
        role_key = modality.value
        if modality == ModelModality.TEXT:
            role_key = "character"
        elif modality == ModelModality.EMBEDDING:
            role_key = "embedding"

        mid = self.get_assigned_model_id(role_key)

        # Fallback: if text/character is missing, check professional (default)
        if not mid and modality == ModelModality.TEXT:
            mid = self.get_assigned_model_id("professional") or self.get_assigned_model_id("professional:default")

        return self.get_model(mid) if mid else None

    def get_model_path(self, pool: Any) -> Path | None:
        """Legacy helper: return the active llama.cpp model path for a pool."""
        model = self.get_active_model(pool)
        if not model or model.loader != ModelLoader.LLAMA_CPP:
            return None
        return Path(model.path)

    def reorder_models(self, pool: Any, model_ids: list[str]) -> bool:
        """Reorder models within a pool (preserves other pools order)."""
        with self._registry_lock:
            modality = self._coerce_modality(pool)

            self._registry = self.registry
            pool_models = [m for m in self._registry.models if m.modality == modality]
            if not pool_models:
                return False

            pool_model_by_id = {m.id: m for m in pool_models}
            requested_ids = [mid for mid in model_ids if mid in pool_model_by_id]
            requested_set = set(requested_ids)

            new_pool_order = [pool_model_by_id[mid] for mid in requested_ids] + [
                m for m in pool_models if m.id not in requested_set
            ]

            replacement_iter = iter(new_pool_order)
            new_models: list[ModelInfo] = []
            for m in self._registry.models:
                if m.modality == modality:
                    new_models.append(next(replacement_iter))
                else:
                    new_models.append(m)

            self._registry.models = new_models
            self._save_registry(self._registry)
            return True

    async def register_local_model(
        self,
        file_path: Path,
        role: Any = ModelModality.TEXT,
        display_name: str | None = None,
    ) -> LocalModelRegistrationResult:
        """Register a local GGUF file as a managed model."""
        self._ensure_dirs()
        modality = self._coerce_modality(role)

        if display_name is None:
            display_name = file_path.stem

        model_id = self._generate_model_id(display_name)
        target_dir = self.models_dir / modality.value
        target_dir.mkdir(exist_ok=True)
        # Use simple name for target file to match expectations if possible, or keep original name?
        # Using original filename is safer.
        target_path = target_dir / file_path.name
        if target_path.exists():
            target_path = target_dir / f"{model_id}{file_path.suffix}"

        try:
            src = file_path.resolve()
            dst = target_path.resolve()
            if src != dst:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, shutil.copy2, src, dst)

            size_bytes = dst.stat().st_size if dst.exists() else 0
            self._register_model_info(
                ModelInfo(
                    id=model_id,
                    name=display_name,
                    loader=ModelLoader.LLAMA_CPP,
                    path=str(dst),
                    modality=modality,
                    source="local",
                    filename=dst.name,
                    size_bytes=size_bytes,
                    added_at=datetime.now(),
                    config=ModelConfig(),
                )
            )
            return LocalModelRegistrationResult(True, model_id=model_id)
        except Exception as exc:  # noqa: BLE001
            logger.error("Failed to register local model: %s", exc, exc_info=True)
            return LocalModelRegistrationResult(False, error_message=str(exc))

    def set_character_model(self, model_id: str) -> bool:
        return self.set_role_model("character", model_id)

    def check_huggingface_update(
        self,
        repo_id: str,
        filename: str,
        current_revision: str | None = None,
        current_sha256: str | None = None,
        current_path: Path | None = None,
    ) -> dict[str, Any]:
        """Compare current model metadata with HuggingFace latest metadata."""
        try:
            meta = _fetch_hf_file_metadata(repo_id, filename)
            latest_revision = meta.get("revision")
            latest_sha256 = meta.get("sha256")

            result: dict[str, Any] = {
                "update_available": False,
                "reason": "insufficient_data",
                "current_revision": current_revision,
                "latest_revision": latest_revision,
                "current_sha256": current_sha256,
                "latest_sha256": latest_sha256,
            }

            if not latest_revision and not latest_sha256:
                result["reason"] = "unknown"
                return result

            if current_revision and latest_revision:
                if str(current_revision) != str(latest_revision):
                    result["update_available"] = True
                    result["reason"] = "revision_mismatch"
                    return result

            if current_sha256 and latest_sha256:
                if str(current_sha256).lower() != str(latest_sha256).lower():
                    result["update_available"] = True
                    result["reason"] = "sha256_mismatch"
                    return result

            # If we can compare at least one dimension and it matches, it's up to date.
            if (current_revision and latest_revision) or (current_sha256 and latest_sha256):
                result["reason"] = "up_to_date"

            return result
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to check HuggingFace update: %s", exc, exc_info=True)
            return {"update_available": False, "reason": "unknown"}

    async def sync_ollama_models(self) -> list[str]:
        """
        Sync available Ollama models into the registry.
        - Fetches full list of models from Ollama.
        - Classifies them as Text or Embedding based on capabilities/name.
        - Filters out unsupported models (e.g. image generation).
        - Registers them.
        """
        runner = OllamaRunner()
        if not await runner._check_connection():
            logger.info("Ollama is not running, skipping sync.")
            return []

        model_names = await runner._list_models()
        synced_ids = []

        for model_tag in model_names:
            # Check capabilities
            caps = await runner.get_capabilities(model_tag)

            # Use data from /api/show
            raw_show = caps.get("raw_show", {})
            details = raw_show.get("details", {})
            families = details.get("families", []) or [details.get("family")]
            # Filter None/Empty from families list
            families = [f for f in families if f]

            # model_capabilities = caps.get("raw_show", {}).get("capabilities", [])

            # Classification Logic
            modality = ModelModality.TEXT

            # Families: bert, nomic-bert
            # Name: embed (heuristic)
            is_embedding = False
            for f in families:
                if f and f.lower() in ("bert", "nomic-bert"):
                    is_embedding = True
                    break
            if not is_embedding and "embed" in model_tag.lower():
                is_embedding = True

            if is_embedding:
                modality = ModelModality.EMBEDDING

            if not is_embedding:
                # Families: clip, mllama
                # Capabilities: vision (if provided by newer Ollama versions)
                is_vision = False
                for f in families:
                    if f and f.lower() in ("clip", "mllama"):
                        is_vision = True
                        break
                if _get_attr(caps, "vision") is True:  # Check parsed cap
                    is_vision = True

                if is_vision:
                    modality = ModelModality.VISION

            # If we detect families that are purely image generation (e.g. latent-diffusion not supported by our current UI)
            # or if it seems to be a tool/adapter only?
            # For now, we assume if it's in `ollama list`, it's runnable.
            # But we explicitly want to exclude image generation models if they don't support text/chat.
            # Heuristic: if families contains 'diffusion' and NOT 'mllama'/'clip', unlikely to be VLM.
            is_unsupported = False
            for f in families:
                if f and "diffusion" in f.lower():
                    # Likely image generation model (e.g. stable-diffusion in ollama if supported later)
                    # or some other non-LLM.
                    is_unsupported = True
                    break

            if is_unsupported:
                logger.info(
                    "Skipping unsupported Ollama model: %s (families: %s)", model_tag, families
                )
                continue

            # Generate ID based on tag (stable for same tag)
            # We prefix with 'ollama-' to distinguish and collision avoid?
            # Or just use model_tag as name?
            # Let's use `ollama-TAG` as ID to avoid collision with local files named same.
            model_id = f"ollama-{model_tag.replace(':', '-').replace('/', '-')}"

            # Size bytes might be available
            # size_bytes = _get_attr(_get_attr(raw_show, "model_info"), "general.parameter_count") or 0
            # actually parameter count is not size in bytes.
            # For now, 0 or estimates is fine.

            # Register
            info = ModelInfo(
                id=model_id,
                name=model_tag,
                loader=ModelLoader.OLLAMA,
                path=model_tag,
                modality=modality,
                source="ollama",
                description=f"Ollama model ({', '.join(families)})",
                added_at=datetime.now(),
                config=ModelConfig(),  # Use defaults
                size_bytes=0,
            )

            self._register_model_info(info)
            synced_ids.append(model_id)

        logger.info("Synced %d Ollama models.", len(synced_ids))
        return synced_ids

    async def delete_model(self, model_id: str) -> bool:
        """Delete a model"""
        model = self.get_model(model_id)
        if not model:
            return False

        # Delete file only if it's managed inside models_dir.
        if model.loader == ModelLoader.LLAMA_CPP:
            p = Path(model.path)
            if p.is_absolute() and p.is_relative_to(self.models_dir):
                try:
                    p.unlink(missing_ok=True)
                except Exception as e:
                    logger.warning("Failed to delete model file: %s", e, exc_info=True)

        # Update registry
        with self._registry_lock:
            self._registry = self.registry
            self._registry.models = [m for m in self._registry.models if m.id != model_id]

            # Remove from roles
            roles_to_remove = [r for r, mid in self._registry.roles.items() if mid == model_id]
            for r in roles_to_remove:
                del self._registry.roles[r]

                # Try to auto-fill fallback
                # (Simplified logic: just leave empty or user must re-assign)

            self._save_registry(self._registry)
        return True

    # -------------------------------------------------------------------------
    # Backward Compatibility / Convenience Wrappers
    # -------------------------------------------------------------------------

    def get_character_model_id(self) -> str | None:
        return self.get_assigned_model_id("character")

    def get_character_model_path(self) -> Path | None:
        mid = self.get_character_model_id()
        if not mid:
            return None
        m = self.get_model(mid)
        if m and m.loader == ModelLoader.LLAMA_CPP:
            return Path(m.path)
        return None

    # -------------------------------------------------------------------------
    # HuggingFace Integration
    # -------------------------------------------------------------------------

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
                    from typing import cast

                    return cast(object, entry)
            return None
        except Exception:
            return None

    def evaluate_download_policy(self, repo_id: str, filename: str) -> DownloadPolicyDecision:
        try:
            from ..config.loader import settings

            download_config = settings.model_download
        except Exception:
            return DownloadPolicyDecision(True, True, ["Config unavailable"], None, None)

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
                return DownloadPolicyDecision(False, False, ["Missing revision"], None, None)
            if verify_sha256 and not expected_sha256:
                return DownloadPolicyDecision(False, False, ["Missing sha256"], None, None)
            return DownloadPolicyDecision(True, False, warnings, revision, expected_sha256)

        # Not allowlisted
        owner = _get_repo_owner(repo_id)
        owner_allowed = owner and owner.lower() in [
            o.lower() for o in download_config.allow_repo_owners
        ]

        requires_consent = False
        if owner_allowed:
            warnings.append(f"Owner '{owner}' allowed; consent required.")
            requires_consent = True
        else:
            if download_config.require_allowlist:
                return DownloadPolicyDecision(False, False, ["Not allowlisted"], None, None)
            if download_config.warn_on_unlisted:
                warnings.append("Not allowlisted; consent required.")
                requires_consent = True

        if download_config.require_revision or verify_sha256:
            metadata = _fetch_hf_file_metadata(repo_id, filename)
            revision = metadata.get("revision")
            expected_sha256 = metadata.get("sha256") if verify_sha256 else None
            if download_config.require_revision and not revision:
                return DownloadPolicyDecision(False, False, ["Cannot resolve revision"], None, None)
            if verify_sha256 and not expected_sha256:
                return DownloadPolicyDecision(False, False, ["Cannot resolve sha256"], None, None)

        return DownloadPolicyDecision(True, requires_consent, warnings, revision, expected_sha256)

    def get_remote_file_size(
        self, repo_id: str, filename: str, revision: str | None = None
    ) -> int | None:
        metadata = _fetch_hf_file_metadata(repo_id, filename, revision=revision)
        return metadata.get("size")

    async def download_from_huggingface(
        self,
        repo_id: str,
        filename: str,
        modality: ModelModality = ModelModality.TEXT,  # V3: use Modality
        display_name: str | None = None,
        consent_provided: bool = False,
        *,
        role: Any | None = None,  # backwards-compatible alias for `modality`
    ) -> DownloadResult:
        """HuggingFace Hubからモデルをダウンロード (V3)"""
        self._ensure_dirs()
        if role is not None:
            modality = self._coerce_modality(role)
        if display_name is None:
            display_name = filename.replace(".gguf", "").replace("-", " ").title()

        try:
            import requests  # type: ignore[import-untyped]
            from huggingface_hub import hf_hub_url

            policy = self.evaluate_download_policy(repo_id, filename)
            if not policy.allowed:
                return DownloadResult(
                    False, error_message=policy.warnings[0] if policy.warnings else "Blocked"
                )

            if policy.requires_consent and not consent_provided:
                return DownloadResult(
                    False,
                    error_message="Consent required",
                    requires_consent=True,
                    warnings=policy.warnings,
                )

            metadata = {}
            if policy.revision is None or policy.expected_sha256 is None:
                metadata = _fetch_hf_file_metadata(repo_id, filename, revision=policy.revision)

            revision = policy.revision or metadata.get("revision")
            expected_sha256 = policy.expected_sha256
            stored_sha256 = policy.expected_sha256 or metadata.get("sha256")

            self._emit_progress(
                ProgressEvent(DownloadStatus.PENDING, 0.0, f"モデル情報を取得中: {repo_id}")
            )

            url = (
                hf_hub_url(repo_id, filename, revision=revision)
                if revision
                else hf_hub_url(repo_id, filename)
            )

            # V3: Put in modality folder (optional but good for org)
            target_dir = self.models_dir / modality.value
            target_dir.mkdir(exist_ok=True)
            target_path = target_dir / filename
            temp_path = target_path.with_suffix(".tmp")

            loop = asyncio.get_running_loop()

            def download_file():
                headers = {}
                downloaded = 0
                if temp_path.exists():
                    downloaded = temp_path.stat().st_size
                    headers["Range"] = f"bytes={downloaded}-"

                with requests.get(url, stream=True, headers=headers, timeout=(10, 60)) as response:
                    response.raise_for_status()
                    if downloaded > 0 and response.status_code == 200:
                        downloaded = 0
                        temp_path.unlink(missing_ok=True)  # Reset if server doesn't support range

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
                                                DownloadStatus.DOWNLOADING,
                                                progress,
                                                f"Downloading: {filename}",
                                                total_bytes=total_size,
                                                current_bytes=downloaded,
                                            )
                                        ),
                                        loop,
                                    )
                if temp_path.exists():
                    temp_path.replace(target_path)
                return target_path

            await loop.run_in_executor(None, download_file)
            downloaded_path = target_path

            # SHA256 Check
            if expected_sha256:
                actual = _sha256_file(downloaded_path)
                if actual.lower() != expected_sha256.lower():
                    downloaded_path.unlink(missing_ok=True)
                    raise ValueError("SHA256 mismatch")

            existing = next(
                (
                    m
                    for m in self.registry.models
                    if m.source == "huggingface"
                    and m.repo_id == repo_id
                    and m.filename == filename
                    and m.modality == modality
                ),
                None,
            )
            model_id = existing.id if existing else self._generate_model_id(display_name)

            self._register_model_info(
                ModelInfo(
                    id=model_id,
                    name=display_name,
                    loader=ModelLoader.LLAMA_CPP,  # Default for HF files
                    path=str(downloaded_path.resolve()),
                    modality=modality,
                    source="huggingface",
                    repo_id=repo_id,
                    filename=filename,
                    revision=revision,
                    sha256=stored_sha256,
                    size_bytes=downloaded_path.stat().st_size,
                    added_at=datetime.now(),
                    config=ModelConfig(),
                )
            )

            self._emit_progress(ProgressEvent(DownloadStatus.COMPLETED, 1.0, "完了"))
            return DownloadResult(True, path=downloaded_path)

        except Exception as e:
            logger.error("Download failed: %s", e, exc_info=True)
            self._emit_progress(ProgressEvent(DownloadStatus.FAILED, 0.0, f"Error: {e}"))
            return DownloadResult(False, error_message=str(e))

    def get_binary_path(self) -> Path | None:
        """llama.cppバイナリのパスを取得"""
        if not self._binary_dir:
            return None
        from ..llm import find_server_executable

        return find_server_executable(self._binary_dir)

    def get_logs_dir(self) -> Path:
        self._logs_dir.mkdir(parents=True, exist_ok=True)
        return self._logs_dir
