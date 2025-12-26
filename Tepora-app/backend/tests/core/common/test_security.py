
import pytest
from pathlib import Path
import os
from src.core.common.security import SecurityUtils

class TestSecurityUtils:
    def test_safe_path_join_valid(self):
        base = Path("/tmp/base")
        result = SecurityUtils.safe_path_join(base, "folder", "file.txt")
        # On windows this might be different, but we mock or use relative checks usually.
        # However, resolve() resolves symlinks and absolute paths.
        # Let's use a temporary directory for real testing or just check string logic if we trust Path.
        # Checking logic with real paths:
        assert result == (base / "folder" / "file.txt").resolve()

    def test_safe_path_join_traversal(self):
        base = Path("/tmp/base")
        with pytest.raises(ValueError, match="Path traversal attempt detected"):
            SecurityUtils.safe_path_join(base, "../secret.txt")

    def test_safe_path_join_traversal_nested(self):
        base = Path("/tmp/base")
        with pytest.raises(ValueError, match="Path traversal attempt detected"):
            SecurityUtils.safe_path_join(base, "folder/../../secret.txt")
            
    def test_validate_path_is_safe_valid(self):
        base = Path("/tmp/base")
        assert SecurityUtils.validate_path_is_safe(base / "safe.txt", base) is True
        
    def test_validate_path_is_safe_invalid(self):
        base = Path("/tmp/base")
        assert SecurityUtils.validate_path_is_safe(base.parent / "unsafe.txt", base) is False

    def test_real_filesystem_traversal(self, tmp_path):
        # Using pytest tmp_path fixture for real filesystem check
        base = tmp_path / "safe_dir"
        base.mkdir()
        
        safe_file = base / "test.log"
        safe_file.touch()
        
        # 1. Valid access
        resolved = SecurityUtils.safe_path_join(base, "test.log")
        assert resolved == safe_file
        
        # 2. Traversal
        with pytest.raises(ValueError):
            SecurityUtils.safe_path_join(base, "../outside.txt")
            
