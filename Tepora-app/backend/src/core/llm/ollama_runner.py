"""
OllamaRunner - Ollama API を使用するランナー（将来実装）

このモジュールは将来のOllama対応用のスケルトン実装です。
現時点では NotImplementedError を送出します。

Ollama対応が実装される際は、以下の機能が追加される予定です:
- Ollama API（http://localhost:11434）への接続
- モデルのプル・ロード・アンロード管理
- ヘルスチェック

Usage (将来):
    runner = OllamaRunner(base_url="http://localhost:11434")

    port = await runner.start(RunnerConfig(
        model_key="llama3.2:3b",
        # model_path は不要（Ollamaがモデルを管理）
    ))
"""

from __future__ import annotations

import logging

from .runner import RunnerConfig, RunnerStatus

__all__ = ["OllamaRunner"]

logger = logging.getLogger(__name__)


class OllamaRunner:
    """
    Ollama API を使用するランナー

    このクラスは将来のOllama対応用のスケルトン実装です。
    現在は全てのメソッドが NotImplementedError を送出します。

    Ollama対応時に実装予定の機能:
    - Ollama API（/api/generate, /api/pull等）への接続
    - モデルのオンデマンドロード
    - 外部プロセス管理不要（Ollamaサービスが管理）

    Attributes:
        _base_url: Ollama APIのベースURL
        _running_models: 実行中モデルの管理
    """

    # Ollamaのデフォルトポート
    DEFAULT_BASE_URL = "http://localhost:11434"
    DEFAULT_API_PORT = 11434

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        """
        OllamaRunner を初期化

        Args:
            base_url: Ollama APIのベースURL
        """
        self._base_url = base_url
        self._running_models: dict[str, int] = {}

        logger.info(
            "OllamaRunner initialized (base_url=%s) - NOTE: Not yet implemented",
            self._base_url,
        )

    async def start(self, config: RunnerConfig) -> int:
        """
        Ollama API 経由でモデルをロードする

        Args:
            config: ランナー起動設定

        Returns:
            Ollama APIのポート番号

        Raises:
            NotImplementedError: 現在は未実装
        """
        raise NotImplementedError(
            "Ollama support is planned for a future release. Please use LlamaServerRunner for now."
        )

    async def stop(self, model_key: str) -> None:
        """
        モデルをアンロードする

        Args:
            model_key: アンロードするモデルの識別子

        Raises:
            NotImplementedError: 現在は未実装
        """
        raise NotImplementedError(
            "Ollama support is planned for a future release. Please use LlamaServerRunner for now."
        )

    def is_running(self, model_key: str) -> bool:
        """
        指定されたモデルがロード済みかどうかを返す

        Args:
            model_key: 確認するモデルの識別子

        Returns:
            ロード済みの場合True
        """
        # スケルトン実装: 常にFalse
        return False

    def get_port(self, model_key: str) -> int | None:
        """
        Ollama APIのポート番号を取得する

        Ollamaの場合、全モデルで同じポートを使用します。

        Args:
            model_key: モデルの識別子

        Returns:
            Ollamaのポート番号、または実行中でない場合はNone
        """
        if not self.is_running(model_key):
            return None
        return self.DEFAULT_API_PORT

    def get_status(self, model_key: str) -> RunnerStatus:
        """
        指定されたモデルの詳細な状態を取得する

        Args:
            model_key: モデルの識別子

        Returns:
            ランナー状態
        """
        return RunnerStatus(
            is_running=False,
            port=None,
            error="Ollama support is not yet implemented",
        )

    def cleanup(self) -> None:
        """
        リソースを解放する

        Ollamaの場合、サービスは外部で管理されているため、
        特別なクリーンアップは不要です。
        """
        logger.info("OllamaRunner cleanup - no action needed (service is external)")
        self._running_models.clear()

