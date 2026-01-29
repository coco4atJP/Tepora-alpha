from __future__ import annotations

import asyncio
import logging
import math
from pathlib import Path

import httpx

from .. import config

__all__ = ["perform_health_check_async"]


async def perform_health_check_async(
    port: int, key: str, *, process_ref, stderr_log_path: Path | None, logger: logging.Logger
) -> None:
    """
    Perform an async health check on the llama.cpp server.

    Args:
        port: The port the server is listening on.
        key: The model key identifier.
        process_ref: A callable that returns the subprocess.Popen object (or None).
        stderr_log_path: Path to the stderr log file for diagnostics.
        logger: Logger instance.

    Raises:
        RuntimeError: If the server process terminates unexpectedly.
        TimeoutError: If the server does not become healthy within the timeout.
    """
    health_check_url = f"http://localhost:{port}/health"
    timeout_config_key = (
        "embedding_health_check_timeout" if "embedding" in key else "health_check_timeout"
    )
    timeout_seconds = float(config.LLAMA_CPP_CONFIG.get(timeout_config_key, 20))
    retry_interval = float(config.LLAMA_CPP_CONFIG.get("health_check_interval", 1.0))
    if retry_interval <= 0:
        retry_interval = 1.0
    max_retries = max(1, int(math.ceil(timeout_seconds / retry_interval)))

    logger.info("Performing health check for '%s' on %s", key, health_check_url)

    async with httpx.AsyncClient() as client:
        for attempt in range(max_retries):
            process = process_ref()
            if stderr_log_path and process and process.poll() is not None:
                raise RuntimeError(
                    f"Server process for '{key}' terminated unexpectedly. "
                    f"Review server log for details: {stderr_log_path}"
                )
            try:
                response = await client.get(health_check_url, timeout=0.5)
                if response.status_code == 200:
                    try:
                        payload = response.json()
                    except ValueError:
                        logger.warning("Invalid health check response body for '%s'", key)
                        await asyncio.sleep(retry_interval)
                        continue

                    if payload.get("status") == "ok":
                        logger.info(
                            "Server for '%s' is healthy (attempt %s/%s)",
                            key,
                            attempt + 1,
                            max_retries,
                        )
                        return
                if response.status_code != 503:
                    logger.warning(
                        "Unexpected health check response %s for '%s'", response.status_code, key
                    )
            except httpx.RequestError as exc:
                logger.debug("Health check request failed for '%s': %s", key, exc)
            await asyncio.sleep(retry_interval)

    raise TimeoutError(
        f"Server for '{key}' did not become healthy within {max_retries * retry_interval} seconds."
        + (f" Review server log for details: {stderr_log_path}" if stderr_log_path else "")
    )
