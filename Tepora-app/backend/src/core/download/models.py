"""
Model Manager - 後方互換ラッパー

このモジュールは後方互換性のために維持されています。
新しいコードは `src.core.models` パッケージを直接使用してください。

DEPRECATED: Use `src.core.models.ModelManager` instead.
"""

# 新しいパッケージからすべてを再エクスポート
from ..models import ModelManager
from ..models.manager import (
    DownloadPolicyDecision,
    DownloadResult,
    DownloadStatus,
    ProgressEvent,
)

__all__ = [
    "ModelManager",
    "DownloadPolicyDecision",
    "DownloadResult",
    "DownloadStatus",
    "ProgressEvent",
]
