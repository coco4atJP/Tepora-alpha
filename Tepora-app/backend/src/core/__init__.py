# Core - Modular Architecture for Tepora

"""
Tepora V2 Core - モジュラーアーキテクチャ

このパッケージは新しいモジュラーアーキテクチャを提供します。
依存関係は一方向フローに従います:

    App -> Graph -> Agent/RAG/Context -> LLM/Tools -> System

ルール:
1. 下位レイヤーは上位レイヤーをインポートしない
2. 兄弟モジュール間の依存は最小限に
3. system と config は基盤として全モジュールからアクセス可能
"""

__version__ = "2.0.0-alpha"

# Phase 1: Foundation exports
# from .app import TeporaApp  # Phase 4で有効化

__all__ = [
    "__version__",
    # "TeporaApp",  # Phase 4で有効化
]
