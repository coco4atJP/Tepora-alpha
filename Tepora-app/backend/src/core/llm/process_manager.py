import logging
import socket
import subprocess
from pathlib import Path

import psutil

from .. import config
from . import launch_server, perform_health_check_async

logger = logging.getLogger(__name__)


class ProcessManager:
    """
    Llama.cppサーバープロセスのライフサイクル管理を担当するクラス。
    """

    def __init__(self):
        # 管理中のプロセス: model_key -> subprocess.Popen
        self._active_processes: dict[str, subprocess.Popen] = {}

    def start_process(self, key: str, command: list, stderr_log_path: Path) -> subprocess.Popen:
        """
        サーバープロセスを起動し、管理対象に追加する。
        既に同じキーで起動中の場合は、既存のプロセスを返す（あるいはエラーにする？今は起動前に停止されている前提）
        """
        if key in self._active_processes:
            existing = self._active_processes[key]
            if existing.poll() is None:
                logger.warning("Process for '%s' is already running. Using existing process.", key)
                return existing
            logger.warning("Process for '%s' was not running. Restarting.", key)
            del self._active_processes[key]

        logger.info("Starting server process for '%s'...", key)
        process = launch_server(command, stderr_log_path=stderr_log_path, logger=logger)
        self._active_processes[key] = process
        logger.info("Server for '%s' started with PID: %d", key, process.pid)
        return process

    def stop_process(self, key: str):
        """
        指定されたキーのプロセスを停止し、管理対象から削除する。
        """
        process = self._active_processes.get(key)
        if not process:
            return

        timeout = config.settings.llm_manager.process_terminate_timeout
        self._terminate_process_tree(process, timeout, context=f"server process for {key}")

        if key in self._active_processes:
            del self._active_processes[key]

    def get_process(self, key: str) -> subprocess.Popen | None:
        return self._active_processes.get(key)

    def find_free_port(self) -> int:
        """Find a free port on localhost."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("localhost", 0))
            return int(s.getsockname()[1])

    async def perform_health_check_async(
        self, port: int, key: str, stderr_log_path: Path | None = None
    ):
        """
        プロセスのヘルスチェックを非同期で行う。
        """

        def get_process_ref():
            return self._active_processes.get(key)

        process_ref = get_process_ref
        try:
            await perform_health_check_async(
                port,
                key,
                process_ref=process_ref,
                stderr_log_path=stderr_log_path,
                logger=logger,
            )
        except Exception as exc:
            # ヘルスチェック失敗時はプロセスを停止する
            logger.error(
                "Health check failed for '%s': %s. Terminating process.", key, exc, exc_info=True
            )
            self.stop_process(key)
            raise

    def cleanup(self):
        """管理中の全プロセスを停止する"""
        keys = list(self._active_processes.keys())
        for key in keys:
            self.stop_process(key)

    def _terminate_process_tree(
        self, process: subprocess.Popen, timeout_sec: int, *, context: str
    ) -> None:
        """
        プロセスツリーを適切に終了させる内部メソッド
        """
        context_title = context.capitalize()
        logger.info("Terminating %s (PID: %d)...", context, process.pid)

        try:
            parent = psutil.Process(process.pid)
            children = parent.children(recursive=True)

            # Send SIGTERM to parent
            parent.terminate()

            _, alive = psutil.wait_procs([parent] + children, timeout=timeout_sec)

            if alive:
                logger.warning("%s didn't terminate gracefully, forcing kill...", context_title)
                for p in alive:
                    try:
                        p.kill()
                    except psutil.NoSuchProcess:
                        pass
                _, alive = psutil.wait_procs(alive, timeout=5)
                if alive:
                    logger.error("Failed to kill %s processes: %s", context_title, alive)
                else:
                    logger.info("%s killed forcefully.", context_title)
            else:
                logger.info("%s terminated gracefully.", context_title)

        except psutil.NoSuchProcess:
            logger.info("%s already terminated.", context_title)
        except Exception as e:
            logger.error("Error while terminating %s: %s", context, e, exc_info=True)
