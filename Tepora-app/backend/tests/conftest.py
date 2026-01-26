import os
import re
import sys
import uuid
from pathlib import Path

import pytest

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
os.environ["TEPORA_SKIP_STARTUP_VALIDATION"] = "1"


@pytest.fixture
def tmp_path(request):  # noqa: D103
    # Override pytest's built-in tmp_path fixture.
    #
    # Rationale: upstream pytest creates tmp directories with mode=0o700. On this environment/FS,
    # that can produce non-listable directories (WinError 5). We create a writable per-test dir
    # ourselves using default permissions.
    base_root = BACKEND_ROOT / "tmp_test_paths"
    base_root.mkdir(parents=True, exist_ok=True)

    safe_name = re.sub(r"[\\W]", "_", request.node.name)[:50]
    path = base_root / f"{safe_name}_{uuid.uuid4().hex}"
    path.mkdir(parents=True, exist_ok=True)
    return path


# --- 3. Mock External Dependencies (Optional/Global) ---
# Example: If you want to prevent ANY real network calls or Heavy loads
# @pytest.fixture(autouse=True)
# def mock_heavy_deps(monkeypatch):
#     pass
