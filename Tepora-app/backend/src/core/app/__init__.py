"""
Application package.

This package provides shared utilities for application startup.

Note:
    The V2 runtime facade is `src.core.app_v2.TeporaApp`.
"""

from __future__ import annotations

from .utils import sanitize_user_input

__all__ = [
    "sanitize_user_input",
]
