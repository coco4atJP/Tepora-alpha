"""
Model Types - モデル管理の型定義

モデル管理で使用するデータクラス、Enum、型定義
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path


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
    revision: str | None = None  # HuggingFace revision (commit hash)
    sha256: str | None = None  # File SHA256 (if verified)
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
class ModelConfig:
    """モデル実行設定

    llama.cpp サーバー起動時に使用するパラメータ
    """

    n_ctx: int = 8192
    n_gpu_layers: int = -1
    temperature: float = 0.7
    top_p: float = 0.9
    top_k: int = 40
    repeat_penalty: float = 1.1
    logprobs: bool = True


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
