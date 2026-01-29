from pathlib import Path

import pytest

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

        resolved = SecurityUtils.safe_path_join(base, "test.log")
        assert resolved == safe_file

        with pytest.raises(ValueError):
            SecurityUtils.safe_path_join(base, "../outside.txt")

    def test_safe_path_join_prefix_collision(self):
        """
        Test that a path starting with the same prefix but not in the same directory is rejected.
        E.g. base="/tmp/data", target="/tmp/database/secret.txt"
        str(target).startswith(str(base)) would be True, but it is unsafe.
        """
        base = Path("/tmp/data")
        # /tmp/database is NOT inside /tmp/data
        # We construct a path that resolves to /tmp/database/secret.txt
        # If we use joinpath, base / "../database/secret.txt" -> /tmp/database/secret.txt

        with pytest.raises(ValueError, match="Path traversal attempt detected"):
            SecurityUtils.safe_path_join(base, "../database/secret.txt")

    def test_validate_path_is_safe_prefix_collision(self):
        base = Path("/tmp/data")
        target = Path("/tmp/database/secret.txt")
        # Should be False, but with simple startswith it might be True
        assert SecurityUtils.validate_path_is_safe(target, base) is False
