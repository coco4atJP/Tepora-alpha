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

from src.core.config.loader import LOG_DIR

# Ensure backend directory is in path for imports if running directly
# sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from src.tepora_server.app_factory import create_app

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
rotating_handler.setFormatter(
    logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout), rotating_handler],
)

os.environ["TORCHDYNAMO_DISABLE"] = "1"

# Clean up old log files on startup
from src.core.log_maintenance import cleanup_llama_server_logs, cleanup_old_logs  # noqa: E402

cleanup_old_logs(log_dir, max_age_days=7)
cleanup_llama_server_logs(log_dir, max_files=20)

if __name__ == "__main__":
    import socket

    import uvicorn

    # 1. Early Port Allocation
    # Bind a socket immediately to get a port and print it to stdout so the Sidecar can see it ASAP
    # This prevents timeouts if create_app() takes a long time (e.g. model loading)
    port = int(os.getenv("PORT", "0"))

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", port))  # If port is 0, OS picks one
    port = sock.getsockname()[1]

    # Output port for Tauri sidecar to capture
    print(f"TEPORA_PORT={port}", flush=True)

    # Close the socket so uvicorn can use it (there's a tiny race condition window here but minimal on local)
    sock.close()

    # 2. App Initialization (Heavy Lift)
    try:
        app = create_app()
    except Exception as e:
        print(f"TEPORA_ERROR={e}", file=sys.stderr)
        logging.critical(f"Failed to create app: {e}", exc_info=True)
        sys.exit(1)

    # 3. Start Server
    uvicorn.run(app, host="127.0.0.1", port=port)
