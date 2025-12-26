# web_server.py
"""
Tepora Web Server Entry Point
Delegates to tepora_server package.
"""
import os
import sys
import logging
from pathlib import Path

# Ensure backend directory is in path for imports if running directly
# sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.tepora_server.app_factory import create_app
from src.core.config.loader import PROJECT_ROOT

# Configure Logging ( Global config for now )
log_dir = PROJECT_ROOT / "logs"
log_dir.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(str(log_dir / "server.log"), encoding='utf-8')
    ]
)

os.environ["TORCHDYNAMO_DISABLE"] = "1"

app = create_app()

if __name__ == "__main__":
    import uvicorn
    # Allow port customization via env
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port)
