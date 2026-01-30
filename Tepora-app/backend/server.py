# web_server.py
"""
Tepora Web Server Entry Point
Delegates to tepora_server package.
"""

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from src.core.common.pii_redactor import contains_pii, redact_pii
from src.core.config.loader import LOG_DIR, config_manager, settings

# Ensure backend directory is in path for imports if running directly
# sys.path.append(os.path.dirname(os.path.abspath(__file__)))
# from src.tepora_server.app_factory import create_app  <-- Moved to lazy import below

# Configure Logging with rotation
# Use LOG_DIR from loader.py which points to %LOCALAPPDATA%/Tepora/logs on Windows
# to avoid PermissionError in Program Files.
try:
    log_dir = LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)
except Exception as e:
    # Fallback to temp dir if something goes wrong with AppData
    import tempfile

    log_dir = Path(tempfile.gettempdir()) / "tepora_logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"Warning: Failed to create log dir at {LOG_DIR}, using {log_dir}. Error: {e}",
        file=sys.stderr,
    )

# RotatingFileHandler: 10MB per file, keep 5 backup files
rotating_handler = RotatingFileHandler(
    str(log_dir / "server.log"),
    maxBytes=10 * 1024 * 1024,  # 10MB
    backupCount=5,
    encoding="utf-8",
)
formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
rotating_handler.setFormatter(formatter)
stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setFormatter(formatter)

logging.basicConfig(
    level=logging.INFO,
    handlers=[stream_handler, rotating_handler],
)

try:
    # Load settings before installing the log redaction filter to avoid recursion
    # (settings initialization emits logs).
    config_manager.load_config()
except Exception as e:
    # Log warning but proceed, as we might be running in a context where full config isn't needed yet
    # or to allow logging to initialize partially.
    print(f"Warning: Failed to load config early: {e}", file=sys.stderr)


class PiiRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if not settings.privacy.redact_pii:
                return True
            message = record.getMessage()
            if not message or not contains_pii(message):
                return True
            redacted, _ = redact_pii(message, enabled=True, log_redactions=False)
            record.msg = redacted
            record.args = ()
        except Exception as e:
            # Never block logging due to redaction errors, but record the issue.
            print(f"[PII Filter] Redaction error (ignored): {e}", file=sys.stderr)
            return True
        return True


pii_filter = PiiRedactionFilter()
stream_handler.addFilter(pii_filter)
rotating_handler.addFilter(pii_filter)

os.environ["TORCHDYNAMO_DISABLE"] = "1"

# Clean up old log files on startup
from src.core.log_maintenance import cleanup_llama_server_logs, cleanup_old_logs  # noqa: E402

cleanup_old_logs(log_dir, max_age_days=7)
cleanup_llama_server_logs(log_dir, max_files=20)

if __name__ == "__main__":
    import socket
    import sys

    # Monkeypatch for uvicorn on Windows (see https://github.com/encode/uvicorn/issues/1007)
    # uvicorn checks socket.AF_UNIX which is missing on Windows < Python 3.10 (or specifically in some envs)
    # triggering AttributeError when passing an fd.
    if sys.platform == "win32" and not hasattr(socket, "AF_UNIX"):
        setattr(socket, "AF_UNIX", -1)

    import uvicorn

    # Bind a socket immediately to get a port and print it to stdout so the Sidecar can see it ASAP
    # This prevents timeouts if create_app() takes a long time (e.g. model loading)
    port = int(os.getenv("PORT", "0"))

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # SO_REUSEADDR allows the socket to be reused immediately after close
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))  # If port is 0, OS picks one
    sock.listen(100)  # Enable listening with a backlog queue
    port = sock.getsockname()[1]

    # Output port for Tauri sidecar to capture
    print(f"TEPORA_PORT={port}", flush=True)
    logging.info(f"Socket bound to 127.0.0.1:{port} (fd={sock.fileno()})")

    # NOTE: Do NOT close the socket here!
    # Keeping the socket open prevents other processes from claiming the port
    # while create_app() is initializing (which can take significant time for model loading).

    try:
        # Lazy import to allow port to be printed ASAP
        from src.tepora_server.app_factory import create_app

        app = create_app()
    except Exception as e:
        sock.close()  # Clean up socket on error
        print(f"TEPORA_ERROR={e}", file=sys.stderr)
        logging.critical(f"Failed to create app: {e}", exc_info=True)
        sys.exit(1)

    # Pass only the file descriptor to uvicorn - do NOT specify host/port when using fd
    # as that would cause uvicorn to attempt rebinding which conflicts with our socket
    fd = sock.fileno()
    logging.info(f"Starting uvicorn server with pre-bound fd={fd}")
    uvicorn.run(app, fd=fd)
