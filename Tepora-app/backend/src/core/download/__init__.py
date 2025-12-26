"""
Download Manager Package

llama.cppバイナリとGGUFモデルのダウンロード・管理機能を提供
"""

from .types import (
    BinaryVariant,
    ModelRole,
    DownloadStatus,
    RequirementStatus,
    ProgressEvent,
    BinaryVersionInfo,
    UpdateInfo,
    ModelInfo,
    ModelRegistry,
    BinaryRegistry,
    RequirementsStatus,
    DownloadResult,
    InstallResult,
    SetupResult,
    ProgressCallback,
)
from .binary import BinaryManager
from .models import ModelManager
from .manager import DownloadManager, get_user_data_dir

__all__ = [
    # Managers
    "DownloadManager",
    "BinaryManager",
    "ModelManager",
    "get_user_data_dir",
    # Enums
    "BinaryVariant",
    "ModelRole",
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
