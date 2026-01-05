"""
Download Manager - Core Types and Data Classes

ダウンロードマネージャーで使用するデータクラス、Enum、型定義
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path


class BinaryVariant(Enum):
    """llama.cpp バイナリのバリアント"""

    AUTO = "auto"  # 自動検出
    CUDA_12_4 = "cuda-12.4"  # NVIDIA CUDA 12.4
    CUDA_11_8 = "cuda-11.8"  # NVIDIA CUDA 11.8
    VULKAN = "vulkan"  # Vulkan (AMD/Intel)
    CPU_AVX2 = "cpu-avx2"  # CPU with AVX2
    CPU_AVX = "cpu-avx"  # CPU with AVX
    CPU_SSE42 = "cpu-sse42"  # CPU with SSE4.2
    METAL = "metal"  # macOS Metal


class ModelPool(Enum):
    """モデルプール（モーダル別分類）

    モデルを主要なモダリティで分類：
    - TEXT: テキスト生成モデル（LLM）- 会話とツール実行に使用
    - EMBEDDING: 埋め込みモデル - 記憶と検索に使用

    将来拡張予定:
    - IMAGE: 画像生成モデル
    - AUDIO: 音声モデル
    """

    TEXT = "text"  # テキスト生成モデル（旧: CHARACTER + EXECUTOR）
    EMBEDDING = "embedding"  # 埋め込みモデル


# 後方互換性のためのエイリアス（非推奨、将来削除予定）
ModelRole = ModelPool


class DownloadStatus(Enum):
    """ダウンロード状態"""

    PENDING = "pending"
    DOWNLOADING = "downloading"
    PAUSED = "paused"
    EXTRACTING = "extracting"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class DownloadJobState:
    """ダウンロードジョブの永続化可能な状態"""

    job_id: str
    status: DownloadStatus
    target_url: str
    target_path: Path
    partial_path: Path  # .part ファイル
    total_bytes: int = 0
    downloaded_bytes: int = 0
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class RequirementStatus(Enum):
    """要件チェック状態"""

    SATISFIED = "satisfied"  # 要件を満たしている
    MISSING = "missing"  # 欠落している
    OUTDATED = "outdated"  # 古いバージョン
    ERROR = "error"  # チェック中にエラー


@dataclass
class ProgressEvent:
    """ダウンロード進捗イベント"""

    status: DownloadStatus
    progress: float  # 0.0 - 1.0
    message: str
    job_id: str | None = None  # ジョブ識別子（レジューム用）
    current_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0  # bytes per second
    eta_seconds: float = 0.0  # 残り時間（秒）


@dataclass
class BinaryVersionInfo:
    """llama.cpp バイナリバージョン情報"""

    version: str  # e.g., "b7211"
    variant: BinaryVariant
    path: Path
    installed_at: datetime
    is_bundled: bool = False  # 同梱CPU版かどうか


@dataclass
class UpdateInfo:
    """更新情報"""

    current_version: str
    latest_version: str
    download_url: str
    release_notes: str = ""
    file_size: int = 0


@dataclass
class ModelInfo:
    """モデル情報"""

    id: str  # 内部ID (e.g., "gemma-3n-e4b-iq4xs")
    display_name: str  # 表示名
    role: ModelRole  # 用途
    file_path: Path  # ファイルパス
    file_size: int  # ファイルサイズ（バイト）
    source: str  # "huggingface" | "local"
    repo_id: str | None = None  # HuggingFace repo (オプション)
    filename: str | None = None  # HuggingFaceファイル名
    is_active: bool = False  # 現在選択中か
    added_at: datetime | None = None


@dataclass
class ModelRegistry:
    """モデルレジストリデータ"""

    version: int = 2  # スキーマバージョン更新
    models: list[ModelInfo] = field(default_factory=list)
    active: dict = field(default_factory=dict)  # role -> model_id

    # ロールベースモデル選択
    character_model_id: str | None = None  # 会話用モデルID
    executor_model_map: dict = field(default_factory=dict)
    # 例: {"default": "model-a", "coding": "model-b", "browser": "model-c"}


@dataclass
class BinaryRegistry:
    """バイナリレジストリデータ"""

    current_version: str | None = None
    current_variant: BinaryVariant | None = None
    installed_versions: list[BinaryVersionInfo] = field(default_factory=list)
    last_update_check: datetime | None = None


@dataclass
class RequirementsStatus:
    """初回起動時の要件チェック結果"""

    binary_status: RequirementStatus
    binary_version: str | None = None

    text_model_status: RequirementStatus = RequirementStatus.MISSING
    text_model_name: str | None = None

    embedding_model_status: RequirementStatus = RequirementStatus.MISSING
    embedding_model_name: str | None = None

    @property
    def is_ready(self) -> bool:
        """すべての要件が満たされているか"""
        return all(
            [
                self.binary_status == RequirementStatus.SATISFIED,
                self.text_model_status == RequirementStatus.SATISFIED,
                self.embedding_model_status == RequirementStatus.SATISFIED,
            ]
        )

    @property
    def has_any_missing(self) -> bool:
        """何か欠落しているものがあるか"""
        return RequirementStatus.MISSING in [
            self.binary_status,
            self.text_model_status,
            self.embedding_model_status,
        ]


@dataclass
class DownloadResult:
    """ダウンロード結果"""

    success: bool
    path: Path | None = None
    error_message: str | None = None


@dataclass
class InstallResult:
    """インストール結果"""

    success: bool
    version: str | None = None
    variant: BinaryVariant | None = None
    path: Path | None = None
    error_message: str | None = None


@dataclass
class SetupResult:
    """初回セットアップ結果"""

    success: bool
    binary_installed: bool = False
    models_installed: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# Type aliases
ProgressCallback = Callable[[ProgressEvent], None]
