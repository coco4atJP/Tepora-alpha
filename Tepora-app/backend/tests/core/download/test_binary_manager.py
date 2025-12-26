import pytest
import re
from pathlib import Path
from src.core.download.binary import BinaryManager
from src.core.download.types import BinaryVariant
import sys

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

