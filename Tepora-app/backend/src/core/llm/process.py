from __future__ import annotations

import logging
import subprocess
from collections.abc import Sequence
from pathlib import Path

__all__ = [
    "build_server_command",
    "launch_server",
]


def build_server_command(
    server_executable: Path,
    model_path: Path,
    *,
    port: int,
    n_ctx: int,
    n_gpu_layers: int,
    extra_args: Sequence[str] | None = None,
) -> list[str]:
    command = [
        str(server_executable),
        "-m",
        str(model_path),
        "--port",
        str(port),
        "-c",
        str(n_ctx),
        "--n-gpu-layers",
        str(n_gpu_layers),
    ]
    if extra_args:
        command.extend(extra_args)
    return command


def launch_server(
    command: Sequence[str], *, stderr_log_path: Path, logger: logging.Logger
) -> subprocess.Popen:
    logger.info("Starting llama.cpp server: %s", " ".join(command))
    logger.info("Server stderr will be logged to: %s", stderr_log_path)
    with open(stderr_log_path, "w", encoding="utf-8") as log_file:
        return subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=log_file)
