"""
LocalModelRunner Protocol - ローカルモデル実行の抽象インターフェース

このモジュールは、ローカルで動作するLLMサーバー（llama.cpp, Ollama等）の
共通インターフェースを定義します。

Usage:
    # DIでランナーを注入
    runner: LocalModelRunner = LlamaServerRunner(binary_path, logs_dir)
    service = LLMService(runner=runner)

    # 直接使用
    port = await runner.start(config)
    client = create_client(port)
    await runner.stop(model_key)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

__all__ = [
    "LocalModelRunner",
    "RunnerConfig",
    "RunnerStatus",
    "RunnerType",
]

logger = logging.getLogger(__name__)


class RunnerType:
    """サポートされるランナータイプ"""

    LLAMA_CPP = "llama_cpp"
    OLLAMA = "ollama"


@dataclass(frozen=True)
class RunnerConfig:
    """
    ランナー起動設定

    Attributes:
        model_key: モデルの一意識別子（キャッシュキー）
        model_path: モデルファイルへのパス（llama.cppの場合）
        port: 使用するポート（0の場合は自動割り当て）
        extra_args: 追加のコマンドライン引数
        model_config: モデル固有の設定（n_ctx, n_gpu_layers等）
    """

    model_key: str
    model_path: Path | None = None
    port: int = 0
    extra_args: list[str] = field(default_factory=list)
    model_config: Any = None

    def __post_init__(self) -> None:
        if not self.model_key:
            raise ValueError("model_key is required")


@dataclass
class RunnerStatus:
    """
    ランナー状態

    Attributes:
        is_running: サーバーが実行中かどうか
        port: 実行中の場合のポート番号
        pid: プロセスID（該当する場合）
        error: エラーメッセージ（該当する場合）
    """

    is_running: bool
    port: int | None = None
    pid: int | None = None
    error: str | None = None


@runtime_checkable
class LocalModelRunner(Protocol):
    """
    ローカルモデル実行ランナーのプロトコル

    このプロトコルは、ローカルで動作するLLMサーバーの共通インターフェースを定義します。
    実装クラス（LlamaServerRunner, OllamaRunner等）はこのプロトコルに準拠する必要があります。

    Example:
        class LlamaServerRunner:
            async def start(self, config: RunnerConfig) -> int:
                # llama-serverプロセスを起動
                ...

            async def stop(self, model_key: str) -> None:
                # プロセスを停止
                ...
    """

    async def start(self, config: RunnerConfig) -> int:
        """
        モデルサーバーを起動する

        Args:
            config: ランナー起動設定

        Returns:
            サーバーがリッスンしているポート番号

        Raises:
            RuntimeError: サーバー起動に失敗した場合
            FileNotFoundError: モデルファイルが見つからない場合
        """
        ...

    async def stop(self, model_key: str) -> None:
        """
        指定されたモデルのサーバーを停止する

        Args:
            model_key: 停止するモデルの識別子
        """
        ...

    def is_running(self, model_key: str) -> bool:
        """
        指定されたモデルのサーバーが実行中かどうかを返す

        Args:
            model_key: 確認するモデルの識別子

        Returns:
            実行中の場合True
        """
        ...

    def get_port(self, model_key: str) -> int | None:
        """
        実行中のサーバーのポート番号を取得する

        Args:
            model_key: モデルの識別子

        Returns:
            ポート番号、または実行中でない場合はNone
        """
        ...

    def get_status(self, model_key: str) -> RunnerStatus:
        """
        指定されたモデルの詳細な状態を取得する

        Args:
            model_key: モデルの識別子

        Returns:
            ランナー状態
        """
        ...

    def cleanup(self) -> None:
        """
        全てのリソースを解放する

        アプリケーション終了時に呼び出されます。
        全ての実行中サーバーを停止し、リソースをクリーンアップします。
        """
        ...
