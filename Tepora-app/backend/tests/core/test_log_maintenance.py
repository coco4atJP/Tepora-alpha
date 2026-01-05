"""Tests for log maintenance utilities."""

import time

import pytest

from src.core.log_maintenance import cleanup_llama_server_logs, cleanup_old_logs


class TestLogMaintenance:
    """Test log cleanup functions."""

    @pytest.fixture
    def log_dir(self, tmp_path):
        """Create a temporary log directory."""
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        return log_dir

    def test_cleanup_old_logs(self, log_dir):
        """Test deletion of files older than max_age_days."""
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

        # Run cleanup (7 days default)
        deleted = cleanup_old_logs(log_dir, max_age_days=7)

        assert deleted == 1
        assert fresh_file.exists()
        assert not old_file.exists()

    def test_cleanup_llama_server_logs(self, log_dir):
        """Test keeping only newest N llama server logs."""
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

        # Run cleanup
        deleted = cleanup_llama_server_logs(log_dir, max_files=max_files)

        # Should delete 2 files (5 - 3 = 2)
        assert deleted == 2

        # Oldest files (index 0, 1) should be gone
        assert not files[0].exists()
        assert not files[1].exists()

        # Newest files (index 2, 3, 4) should remain
        assert files[2].exists()
        assert files[3].exists()
        assert files[4].exists()

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
