import re
import sys

import pytest

from src.core.download.binary import BinaryManager
from src.core.download.types import BinaryVariant

# Mock platform if needed, but we can just instantiate BinaryManager
# and call the method directly for testing logic.


class TestBinaryManagerRegex:
    @pytest.fixture
    def manager(self, tmp_path):
        return BinaryManager(bin_dir=tmp_path / "bin")

    def test_windows_patterns(self, manager):
        # Temporarily mock sys.platform to win32 for this test context if needed
        # But _get_asset_regex checks sys.platform.
        # We need to force it or mock it.
        with pytest.MonkeyPatch.context() as m:
            m.setattr(sys, "platform", "win32")

            # CUDA 12.4
            regex = manager._get_asset_regex(BinaryVariant.CUDA_12_4)
            # New format: llama-b7527-bin-win-cuda-12.4-x64.zip
            assert re.search(regex, "llama-b7527-bin-win-cuda-12.4-x64.zip")
            assert not re.search(regex, "llama-b7527-bin-win-cpu-x64.zip")

            # AVX2 -> now maps to win-cpu-x64
            regex = manager._get_asset_regex(BinaryVariant.CPU_AVX2)
            assert re.search(regex, "llama-b7527-bin-win-cpu-x64.zip")
            assert not re.search(regex, "llama-b7527-bin-win-cuda-12.4-x64.zip")

    def test_macos_patterns(self, manager):
        with pytest.MonkeyPatch.context() as m:
            m.setattr(sys, "platform", "darwin")

            # ARM64 (Metal)
            regex = manager._get_asset_regex(BinaryVariant.METAL)
            # New format: tar.gz
            assert re.search(regex, "llama-b7527-bin-macos-arm64.tar.gz")
            # Should not match Intel
            assert not re.search(regex, "llama-b7527-bin-macos-x64.tar.gz")

    def test_linux_patterns(self, manager):
        with pytest.MonkeyPatch.context() as m:
            m.setattr(sys, "platform", "linux")

            # Linux CUDA 12.4
            # Linux CUDA 12.4 (might be missing in recent releases, but checking regex if we support it)
            # If valid, might be: llama-b7527-bin-linux-cuda-12.4-x64.tar.gz
            # For now let's verify ubuntu-cpu

            # Ubuntu CPU
            regex = manager._get_asset_regex(BinaryVariant.CPU_AVX2)
            assert re.search(regex, "llama-b7527-bin-ubuntu-x64.tar.gz")


class TestBinaryManagerHashVerification:
    """Tests for SHA256 hash verification (P0-6 supply chain security)."""

    @pytest.fixture
    def manager(self, tmp_path):
        return BinaryManager(bin_dir=tmp_path / "bin")

    def test_verify_file_hash_correct(self, manager, tmp_path):
        """Test that correct SHA256 hash passes verification."""
        # Create a test file with known content
        test_file = tmp_path / "test_file.bin"
        test_content = b"Hello, World! This is a test file for hash verification."
        test_file.write_bytes(test_content)

        # SHA256 of the test content (pre-calculated)
        import hashlib

        expected_hash = hashlib.sha256(test_content).hexdigest()

        # Verify that the hash matches
        assert manager._verify_file_hash(test_file, expected_hash) is True

    def test_verify_file_hash_incorrect(self, manager, tmp_path):
        """Test that incorrect SHA256 hash fails verification."""
        # Create a test file
        test_file = tmp_path / "test_file.bin"
        test_content = b"Original content"
        test_file.write_bytes(test_content)

        # Use a wrong hash (hash of different content)
        wrong_hash = "0" * 64  # All zeros - definitely wrong

        # Verify that the hash does not match
        assert manager._verify_file_hash(test_file, wrong_hash) is False

    def test_verify_file_hash_case_insensitive(self, manager, tmp_path):
        """Test that hash comparison is case-insensitive."""
        test_file = tmp_path / "test_file.bin"
        test_content = b"Test content"
        test_file.write_bytes(test_content)

        import hashlib

        expected_hash = hashlib.sha256(test_content).hexdigest()

        # Test with uppercase hash
        assert manager._verify_file_hash(test_file, expected_hash.upper()) is True
        # Test with lowercase hash
        assert manager._verify_file_hash(test_file, expected_hash.lower()) is True

    def test_verify_file_hash_nonexistent_file(self, manager, tmp_path):
        """Test that verification fails for non-existent file."""
        nonexistent_file = tmp_path / "nonexistent.bin"

        # Should return False, not raise an exception
        assert manager._verify_file_hash(nonexistent_file, "a" * 64) is False
