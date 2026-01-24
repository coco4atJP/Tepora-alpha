"""Tests for log maintenance utilities."""

import time
from pathlib import Path

import pytest

from src.core.log_maintenance import cleanup_llama_server_logs, cleanup_old_logs


def _can_delete_files(base: Path) -> bool:
    probe = base / ".delete_probe"
    try:
        probe.touch()
        probe.unlink()
        return True
    except OSError:
        return False


class TestLogMaintenance:
    """Test log cleanup functions."""

    @pytest.fixture
    def log_dir(self, tmp_path):
        """Create a temporary log directory."""
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        return log_dir

    def test_cleanup_old_logs(self, log_dir, monkeypatch):
        """Test selection of files older than max_age_days for deletion."""
        # Create a fresh file (should be kept)
        fresh_file = log_dir / "fresh.log"
        fresh_file.touch()

        # Create an old file (should be deleted)
        old_file = log_dir / "old.log"
        old_file.touch()

        # Manually set mtime to 8 days ago
        old_time = time.time() - (8 * 24 * 3600)
        import os

        os.utime(old_file, (old_time, old_time))

        if _can_delete_files(log_dir):
            deleted = cleanup_old_logs(log_dir, max_age_days=7)
            assert deleted == 1
            assert fresh_file.exists()
            assert not old_file.exists()
            return

        deleted_files: list[Path] = []

        def fake_unlink(self: Path):
            deleted_files.append(self)

        # Filesystem deletion can be restricted in some environments, so we stub unlink.
        monkeypatch.setattr(Path, "unlink", fake_unlink)

        # Run cleanup (7 days default)
        deleted = cleanup_old_logs(log_dir, max_age_days=7)

        assert deleted == 1
        assert fresh_file not in deleted_files
        assert old_file in deleted_files

    def test_cleanup_llama_server_logs(self, log_dir, monkeypatch):
        """Test selection of llama server logs for deletion (keep newest N)."""
        max_files = 3
        model_type = "character_model"

        # Create 5 log files with different timestamps
        files = []
        for i in range(5):
            p = log_dir / f"llama_server_{model_type}_{i}.log"
            p.touch()
            # Ensure different mtimes (newest has higher index)
            mtime = time.time() - (5 - i) * 10
            import os

            os.utime(p, (mtime, mtime))
            files.append(p)

        if _can_delete_files(log_dir):
            deleted = cleanup_llama_server_logs(log_dir, max_files=max_files)
            assert deleted == 2
            assert not files[0].exists()
            assert not files[1].exists()
            assert files[2].exists()
            assert files[3].exists()
            assert files[4].exists()
            return

        deleted_files: list[Path] = []

        def fake_unlink(self: Path):
            deleted_files.append(self)

        monkeypatch.setattr(Path, "unlink", fake_unlink)

        # Run cleanup
        deleted = cleanup_llama_server_logs(log_dir, max_files=max_files)

        # Should delete 2 files (5 - 3 = 2)
        assert deleted == 2

        # Oldest files (index 0, 1) should be selected for deletion
        assert files[0] in deleted_files
        assert files[1] in deleted_files

        # Newest files (index 2, 3, 4) should not be selected for deletion
        assert files[2] not in deleted_files
        assert files[3] not in deleted_files
        assert files[4] not in deleted_files

    def test_cleanup_ignore_non_log_files(self, log_dir):
        """Test that non-log files are ignored by default."""
        # Create an old text file
        old_txt = log_dir / "old.txt"
        old_txt.touch()

        old_time = time.time() - (8 * 24 * 3600)
        import os

        os.utime(old_txt, (old_time, old_time))

        deleted = cleanup_old_logs(log_dir, max_age_days=7)

        assert deleted == 0
        assert old_txt.exists()
