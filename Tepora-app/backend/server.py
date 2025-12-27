# web_server.py
"""
Tepora Web Server Entry Point
Delegates to tepora_server package.
"""
import os
import sys
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Ensure backend directory is in path for imports if running directly
# sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.tepora_server.app_factory import create_app
from src.core.config.loader import PROJECT_ROOT

# Configure Logging with rotation
log_dir = PROJECT_ROOT / "logs"
log_dir.mkdir(parents=True, exist_ok=True)

# RotatingFileHandler: 10MB per file, keep 5 backup files
rotating_handler = RotatingFileHandler(
    str(log_dir / "server.log"),
    maxBytes=10 * 1024 * 1024,  # 10MB
    backupCount=5,
    encoding='utf-8'
)
rotating_handler.setFormatter(
    logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        rotating_handler
    ]
)

os.environ["TORCHDYNAMO_DISABLE"] = "1"

# Clean up old log files on startup
from src.core.log_maintenance import cleanup_old_logs, cleanup_llama_server_logs
cleanup_old_logs(log_dir, max_age_days=7)
cleanup_llama_server_logs(log_dir, max_files=20)

app = create_app()

if __name__ == "__main__":
    import uvicorn
    import socket
    
    # Dynamic port allocation: let OS assign a free port
    port = int(os.getenv("PORT", "0"))  # 0 = OS assigns free port
    
    if port == 0:
        # Get a free port from OS
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
    
    # Output port for Tauri sidecar to capture
    print(f"TEPORA_PORT={port}", flush=True)
    
    uvicorn.run(app, host="127.0.0.1", port=port)

