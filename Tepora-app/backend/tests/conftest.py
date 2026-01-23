import os
import sys
from pathlib import Path

# --- 1. Path Setup ---
# Add 'backend' to sys.path so 'src' module can be found
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Also ensure 'src' is importable if needed, though 'from src...' is preferred
SRC_ROOT = BACKEND_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

# --- 2. Environment Setup ---
os.environ["TEPORA_ENV"] = "test"
os.environ["MODEL_BASE_PATH"] = str(BACKEND_ROOT / "tests" / "mock_models")

# --- 3. Mock External Dependencies (Optional/Global) ---
# Example: If you want to prevent ANY real network calls or Heavy loads
# @pytest.fixture(autouse=True)
# def mock_heavy_deps(monkeypatch):
#     monkeypatch.setattr("src.core.llm_manager.LLMManager", MagicMock())
