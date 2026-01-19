"""
Model Management Package

GGUFモデルの管理機能を提供:
- モデルレジストリ（登録・削除・一覧）
- モデル設定の解決
- アクティブモデルの管理
"""

from .config import ModelConfigResolver
from .manager import ModelManager
from .types import (
    ModelConfig,
    ModelInfo,
    ModelPool,
    ModelRegistry,
    ModelRole,  # 後方互換エイリアス
)

__all__ = [
    # Manager
    "ModelManager",
    "ModelConfigResolver",
    # Types
    "ModelPool",
    "ModelRole",  # 後方互換エイリアス
    "ModelInfo",
    "ModelRegistry",
    "ModelConfig",
]
