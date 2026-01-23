"""
Conftest for core_v2 tests.

Ensures src directory is in sys.path before any test imports.
"""

import sys
from pathlib import Path

# Ensure src is in path BEFORE any imports
_src_dir = Path(__file__).resolve().parents[2] / "src"
if str(_src_dir) not in sys.path:
    sys.path.insert(0, str(_src_dir))
