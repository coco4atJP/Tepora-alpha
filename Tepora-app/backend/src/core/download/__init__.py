"""
Download Manager Package

llama.cppバイナリとGGUFモデルのダウンロード・管理機能を提供
"""

from .binary import BinaryManager
from .manager import DownloadManager, get_user_data_dir
from .models import ModelManager
from .types import (
    BinaryRegistry,
    BinaryVariant,
    BinaryVersionInfo,
    DownloadResult,
    DownloadStatus,
    InstallResult,
    ModelInfo,
    ModelPool,
    ModelRegistry,
    ModelRole,  # 後方互換エイリアス
    ProgressCallback,
    ProgressEvent,
    RequirementsStatus,
    RequirementStatus,
    SetupResult,
    UpdateInfo,
)

__all__ = [
    # Managers
    "DownloadManager",
    "BinaryManager",
    "ModelManager",
    "get_user_data_dir",
    # Enums
    "BinaryVariant",
    "ModelPool",
    "ModelRole",  # 後方互換エイリアス
    "DownloadStatus",
    "RequirementStatus",
    # Data classes
    "ProgressEvent",
    "BinaryVersionInfo",
    "UpdateInfo",
    "ModelInfo",
    "ModelRegistry",
    "BinaryRegistry",
    "RequirementsStatus",
    "DownloadResult",
    "InstallResult",
    "SetupResult",
    # Type aliases
    "ProgressCallback",
]
