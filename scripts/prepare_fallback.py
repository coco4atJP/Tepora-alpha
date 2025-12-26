#!/usr/bin/env python3
"""
Prepare fallback binaries for Tauri build.

This script detects the current OS and extracts the appropriate
CPU fallback binary to the Tauri resources directory.

Usage:
    python scripts/prepare_fallback.py [--platform PLATFORM]

Options:
    --platform PLATFORM  Override platform detection (win, macos, linux)
"""

import argparse
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

# Constants
PROJECT_ROOT = Path(__file__).resolve().parents[1]
STORAGE_DIR = PROJECT_ROOT / "格納"  # Directory containing downloaded binaries
RESOURCES_DIR = PROJECT_ROOT / "frontend" / "src-tauri" / "resources"
FALLBACK_DIR = RESOURCES_DIR / "llama-cpu-fallback"

# Binary archive mappings
BINARIES = {
    "win": {
        "archive": "llama-b7418-bin-win-cpu-x64.zip",
        "exe_name": "llama-server.exe",
    },
    "win-arm64": {
        "archive": "llama-b7418-bin-win-cpu-arm64.zip",
        "exe_name": "llama-server.exe",
    },
    "macos": {
        "archive": "llama-b7418-bin-macos-arm64.tar.gz",
        "exe_name": "llama-server",
    },
    "linux": {
        "archive": "llama-b7418-bin-ubuntu-x64.tar.gz",
        "exe_name": "llama-server",
    },
}


def detect_platform() -> str:
    """Detect the current platform."""
    import platform
    
    if sys.platform == "win32":
        # Check for ARM64
        if platform.machine().lower() in ("arm64", "aarch64"):
            return "win-arm64"
        return "win"
    elif sys.platform == "darwin":
        return "macos"
    else:
        return "linux"


def extract_archive(archive_path: Path, dest_dir: Path) -> bool:
    """Extract archive to destination directory."""
    print(f"Extracting {archive_path.name} to {dest_dir}...")
    
    if archive_path.suffix == ".zip":
        with zipfile.ZipFile(archive_path, "r") as zf:
            zf.extractall(dest_dir)
    elif archive_path.name.endswith(".tar.gz"):
        with tarfile.open(archive_path, "r:gz") as tf:
            tf.extractall(dest_dir)
    else:
        print(f"Unknown archive format: {archive_path}")
        return False
    
    return True


def verify_executable(dest_dir: Path, exe_name: str) -> bool:
    """Verify that the executable was extracted correctly."""
    for path in dest_dir.rglob(exe_name):
        if path.is_file():
            print(f"✓ Found executable: {path}")
            return True
    
    print(f"✗ Executable not found: {exe_name}")
    return False


def prepare_fallback(platform: str) -> bool:
    """Prepare fallback binaries for the specified platform."""
    if platform not in BINARIES:
        print(f"Unknown platform: {platform}")
        return False
    
    config = BINARIES[platform]
    archive_path = STORAGE_DIR / config["archive"]
    
    if not archive_path.exists():
        print(f"Archive not found: {archive_path}")
        print(f"Please download the binary and place it in: {STORAGE_DIR}")
        return False
    
    # Clean existing fallback directory
    if FALLBACK_DIR.exists():
        print(f"Cleaning existing fallback directory...")
        shutil.rmtree(FALLBACK_DIR)
    
    FALLBACK_DIR.mkdir(parents=True, exist_ok=True)
    
    # Extract archive
    if not extract_archive(archive_path, FALLBACK_DIR):
        return False
    
    # Verify executable
    if not verify_executable(FALLBACK_DIR, config["exe_name"]):
        return False
    
    print(f"\n✓ Successfully prepared {platform} fallback binaries")
    return True


def main():
    parser = argparse.ArgumentParser(description="Prepare fallback binaries for Tauri build")
    parser.add_argument(
        "--platform",
        choices=["win", "win-arm64", "macos", "linux"],
        help="Override platform detection",
    )
    args = parser.parse_args()
    
    platform = args.platform or detect_platform()
    print(f"Preparing fallback binaries for platform: {platform}")
    print(f"Storage directory: {STORAGE_DIR}")
    print(f"Resources directory: {RESOURCES_DIR}")
    print()
    
    if not prepare_fallback(platform):
        sys.exit(1)
    
    print("\nReady for Tauri build!")


if __name__ == "__main__":
    main()
