"""
LlamaServerRunner - llama.cpp サーバープロセス管理ランナー

llama.cpp の llama-server プロセスのライフサイクルを管理します。
LocalModelRunner プロトコルを実装しており、LLMService から使用されます。

Usage:
    runner = LlamaServerRunner(
        binary_path=Path("/path/to/llama-server"),
        logs_dir=Path("logs"),
    )

    port = await runner.start(RunnerConfig(
        model_key="character_model",
        model_path=Path("/path/to/model.gguf"),
        model_config=model_config,
    ))

    # クライアントを作成して使用...

    await runner.stop("character_model")
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Any

import httpx

from .process import build_server_command
from .process_manager import ProcessManager
from .runner import RunnerConfig, RunnerStatus

__all__ = ["LlamaServerRunner"]

logger = logging.getLogger(__name__)


class LlamaServerRunner:
    """
    llama.cpp サーバープロセスを管理するランナー

    ProcessManager を内部で使用し、llama-server プロセスの起動・停止・
    ヘルスチェックを行います。

    Attributes:
        _process_manager: プロセスライフサイクル管理
        _binary_path: llama-server 実行ファイルへのパス
        _logs_dir: サーバーログ出力先ディレクトリ
        _port_map: model_key -> port のマッピング
    """

    def __init__(
        self,
        binary_path: Path | None = None,
        logs_dir: Path | None = None,
    ) -> None:
        """
        LlamaServerRunner を初期化

        Args:
            binary_path: llama-server 実行ファイルへのパス
            logs_dir: サーバーログ出力先ディレクトリ
        """
        self._process_manager = ProcessManager()
        self._binary_path = binary_path
        self._logs_dir = logs_dir or Path("logs")
        self._port_map: dict[str, int] = {}

        logger.info(
            "LlamaServerRunner initialized (binary=%s, logs=%s)",
            self._binary_path,
            self._logs_dir,
        )

    async def start(self, config: RunnerConfig) -> int:
        """
        llama-server プロセスを起動する

        Args:
            config: ランナー起動設定

        Returns:
            サーバーがリッスンしているポート番号

        Raises:
            RuntimeError: サーバー起動に失敗した場合
            FileNotFoundError: モデルファイルまたは実行ファイルが見つからない場合
            ValueError: 設定が不正な場合
        """
        model_key = config.model_key
        model_path = config.model_path

        # 既に起動中の場合はそのポートを返す
        if self.is_running(model_key):
            existing_port = self._port_map.get(model_key)
            if existing_port:
                logger.info(
                    "Model '%s' is already running on port %d",
                    model_key,
                    existing_port,
                )
                return existing_port

        # バリデーション
        if model_path is None:
            raise ValueError(f"model_path is required for llama.cpp runner: {model_key}")

        if not model_path.exists():
            raise FileNotFoundError(f"Model file not found: {model_path}")

        if self._binary_path is None:
            raise FileNotFoundError("llama-server binary path is not configured")

        if not self._binary_path.exists():
            raise FileNotFoundError(f"llama-server binary not found: {self._binary_path}")

        # ポート割り当て
        port = config.port if config.port > 0 else self._process_manager.find_free_port()

        # ログファイルパス
        self._logs_dir.mkdir(parents=True, exist_ok=True)
        safe_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", model_key)
        stderr_log_path = self._logs_dir / f"llama_server_{safe_key}_{int(time.time())}.log"

        # コマンド構築
        model_config = config.model_config
        n_ctx = getattr(model_config, "n_ctx", 8192) if model_config else 8192
        n_gpu_layers = getattr(model_config, "n_gpu_layers", -1) if model_config else -1

        command = build_server_command(
            self._binary_path,
            model_path,
            port=port,
            n_ctx=n_ctx,
            n_gpu_layers=n_gpu_layers,
            extra_args=config.extra_args if config.extra_args else None,
        )

        logger.info("Starting llama-server for '%s' on port %d", model_key, port)

        # プロセス起動
        try:
            self._process_manager.start_process(model_key, command, stderr_log_path)
        except Exception as exc:
            logger.error("Failed to start llama-server for '%s': %s", model_key, exc)
            raise RuntimeError(f"Failed to start llama-server: {exc}") from exc

        # ヘルスチェック
        try:
            await self._process_manager.perform_health_check_async(port, model_key, stderr_log_path)
        except Exception as exc:
            logger.error(
                "Health check failed for '%s': %s. Stopping process.",
                model_key,
                exc,
            )
            self._process_manager.stop_process(model_key)
            raise RuntimeError(f"Server health check failed: {exc}") from exc

        # ポートを記録
        self._port_map[model_key] = port

        logger.info(
            "llama-server for '%s' started successfully on port %d",
            model_key,
            port,
        )

        return port

    async def stop(self, model_key: str) -> None:
        """
        指定されたモデルのサーバーを停止する

        Args:
            model_key: 停止するモデルの識別子
        """
        if model_key not in self._port_map:
            logger.debug("Model '%s' is not running, nothing to stop", model_key)
            return

        logger.info("Stopping llama-server for '%s'", model_key)

        self._process_manager.stop_process(model_key)

        if model_key in self._port_map:
            del self._port_map[model_key]

        logger.info("llama-server for '%s' stopped", model_key)

    def is_running(self, model_key: str) -> bool:
        """
        指定されたモデルのサーバーが実行中かどうかを返す

        Args:
            model_key: 確認するモデルの識別子

        Returns:
            実行中の場合True
        """
        process = self._process_manager.get_process(model_key)
        if process is None:
            return False

        # poll() が None なら実行中
        return process.poll() is None

    def get_port(self, model_key: str) -> int | None:
        """
        実行中のサーバーのポート番号を取得する

        Args:
            model_key: モデルの識別子

        Returns:
            ポート番号、または実行中でない場合はNone
        """
        if not self.is_running(model_key):
            return None
        return self._port_map.get(model_key)

    def get_status(self, model_key: str) -> RunnerStatus:
        """
        指定されたモデルの詳細な状態を取得する

        Args:
            model_key: モデルの識別子

        Returns:
            ランナー状態
        """
        process = self._process_manager.get_process(model_key)

        if process is None:
            return RunnerStatus(is_running=False)

        is_running = process.poll() is None
        port = self._port_map.get(model_key) if is_running else None
        pid = process.pid if is_running else None

        return RunnerStatus(
            is_running=is_running,
            port=port,
            pid=pid,
        )

    def cleanup(self) -> None:
        """
        全てのリソースを解放する

        全ての実行中サーバーを停止し、リソースをクリーンアップします。
        """
        logger.info("Cleaning up LlamaServerRunner...")

        # ProcessManager にクリーンアップを委譲
        self._process_manager.cleanup()

        # ポートマップをクリア
        self._port_map.clear()

        logger.info("LlamaServerRunner cleanup complete")

    async def count_tokens(self, text: str, model_key: str) -> int:
        """llama.cpp サーバーの /tokenize エンドポイントを使用してトークン数をカウントする"""
        if not text:
            return 0

        port = self.get_port(model_key)
        if port is None:
            # サーバーが起動していない場合は概算（フォールバック）
            return len(text) // 4

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"http://127.0.0.1:{port}/tokenize",
                    json={"content": text},
                    timeout=5.0,
                )
            if response.status_code != 200:
                logger.debug(
                    "Tokenize endpoint returned status %s (port=%s)",
                    response.status_code,
                    port,
                )
                return len(text) // 4

            payload = response.json()
            tokens = payload.get("tokens", [])
            if isinstance(tokens, list):
                return len(tokens)
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "Failed to get token count from server (port=%s): %s",
                port,
                exc,
            )

        # フォールバック
        return len(text) // 4

    def get_base_url(self, model_key: str) -> str | None:
        """localhostのURLを返す"""
        port = self.get_port(model_key)
        if port is None:
            return None
        return f"http://127.0.0.1:{port}"

    async def get_capabilities(self, model_key: str) -> dict[str, Any]:
        """GET /props からモデル情報を取得する"""
        port = self.get_port(model_key)
        if port is None:
            return {}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"http://127.0.0.1:{port}/props",
                    timeout=5.0,
                )
            if response.status_code != 200:
                logger.warning("Failed to get props from server: %s", response.status_code)
                return {}

            props = response.json()
            # props = {
            #   "model_path": "...",
            #   "chat_template": "...",
            #   "modalities": { "vision": bool },
            #   ...
            # }
            modalities = props.get("modalities", {})
            return {
                "vision": modalities.get("vision", False),
                "chat_template": props.get("chat_template"),
                "model_path": props.get("model_path"),
                "raw_props": props,  # 将来のため生データも保持
            }

        except Exception as exc:
            logger.warning("Failed to get capabilities: %s", exc)
            return {}
