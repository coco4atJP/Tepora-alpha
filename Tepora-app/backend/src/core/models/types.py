"""
Model Types - モデル管理の型定義

モデル管理で使用するデータクラス、Enum、型定義
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path


class ModelLoader(str, Enum):
    """モデル実行ローダー"""

    LLAMA_CPP = "llama_cpp"
    OLLAMA = "ollama"


class ModelModality(str, Enum):
    """モデルモダリティ"""

    TEXT = "text"
    EMBEDDING = "embedding"
    VISION = "vision"
    AUDIO = "audio"


# ---------------------------------------------------------------------------
# Backward-compatible aliases (V2 -> V3 migration)
# ---------------------------------------------------------------------------

# Historically the codebase used "ModelPool"/"ModelRole" (text/embedding).
# V3 uses "ModelModality" as the canonical classification.
ModelPool = ModelModality
ModelRole = ModelPool


@dataclass
class ModelConfig:
    """モデル実行設定

    共通の実行パラメータ。
    ローダーによっては無視される項目もある。
    """

    n_ctx: int = 8192
    n_gpu_layers: int = -1
    temperature: float = 0.7
    top_p: float = 0.9
    top_k: int = 40
    repeat_penalty: float = 1.1
    logprobs: bool = True

    # 追加パラメータ用
    extra_args: list[str] = field(default_factory=list)


@dataclass
class ModelInfo:
    """モデル情報"""

    # 基本情報
    id: str  # 固有ID (UUID)
    name: str  # モデル名 (表示用)
    loader: ModelLoader
    path: str  # ファイルパス または Ollamaタグ
    modality: ModelModality

    # メタデータ
    description: str | None = None
    source: str | None = None  # "huggingface", "local", "ollama_library"
    repo_id: str | None = None  # HuggingFace repo
    filename: str | None = None  # HuggingFace filename
    revision: str | None = None  # HuggingFace revision (commit hash)
    sha256: str | None = None  # HuggingFace/LFS sha256 (if available/verified)
    size_bytes: int = 0
    added_at: datetime | None = None

    # モデル個別の推奨設定
    config: ModelConfig = field(default_factory=ModelConfig)

    # --- V2 compatibility (read-only properties) ---

    @property
    def display_name(self) -> str:
        return self.name

    @property
    def role(self) -> ModelPool:
        return self.modality

    @property
    def file_path(self) -> Path:
        return Path(self.path)

    @property
    def file_size(self) -> int:
        return int(self.size_bytes or 0)


@dataclass
class ModelRegistry:
    """モデルレジストリデータ - models.json の構造"""

    version: int = 3  # Schema version update
    models: list[ModelInfo] = field(default_factory=list)

    # Role assignments (Role Name -> Model ID)
    # 例: "character" -> "uuid-...", "embedding" -> "uuid-..."
    roles: dict[str, str] = field(default_factory=dict)

    # --- V2 compatibility (computed properties) ---

    @property
    def character_model_id(self) -> str | None:
        return self.roles.get("character") or self.active.get("text")

    @property
    def active(self) -> dict[str, str]:
        active: dict[str, str] = {}

        # Legacy concept: active pool model (text/embedding).
        # V3 prefers explicit roles, so map them deterministically.
        if self.roles.get("character"):
            active["text"] = self.roles["character"]

        if self.roles.get("embedding"):
            active["embedding"] = self.roles["embedding"]

        return active


# 進捗コールバック型（download パッケージと共有）
@dataclass
class ProgressEvent:
    """進捗イベント"""

    status: str  # DownloadStatus の値
    progress: float  # 0.0 - 1.0
    message: str
    job_id: str | None = None
    current_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0
    eta_seconds: float = 0.0


ProgressCallback = Callable[[ProgressEvent], None]
