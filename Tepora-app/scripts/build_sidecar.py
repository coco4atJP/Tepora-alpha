
import os
import sys
import shutil
import subprocess
from pathlib import Path

# Constants
PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
FRONTEND_TAURI_DIR = PROJECT_ROOT / "frontend" / "src-tauri"
BINARIES_DIR = FRONTEND_TAURI_DIR / "binaries"

# Determine current platform's target triple
# For Windows, usually x86_64-pc-windows-msvc
# You can run `rustc -vV` to get "host: ..." if rust is installed, or hardcode/detect.
def get_target_triple():
    # Simple detection for Windows x64
    if sys.platform == "win32":
        return "x86_64-pc-windows-msvc"
    elif sys.platform == "darwin":
        # Check architecture
        import platform
        if platform.machine() == "arm64":
            return "aarch64-apple-darwin"
        else:
            return "x86_64-apple-darwin"
    else:
        # Default to linux x64 for now
        return "x86_64-unknown-linux-gnu"

TARGET_TRIPLE = get_target_triple()
EXECUTABLE_NAME = "tepora-backend"
if sys.platform == "win32":
    FULL_EXECUTABLE_NAME = f"{EXECUTABLE_NAME}-{TARGET_TRIPLE}.exe"
else:
    FULL_EXECUTABLE_NAME = f"{EXECUTABLE_NAME}-{TARGET_TRIPLE}"

def clean():
    print("Cleaning previous builds...")
    dist_dir = BACKEND_DIR / "dist"
    build_dir = BACKEND_DIR / "build"
    spec_file = BACKEND_DIR / "server.spec"
    
    if dist_dir.exists(): shutil.rmtree(dist_dir)
    if build_dir.exists(): shutil.rmtree(build_dir)
    # Don't delete spec file if we want to reuse it, but here we might auto-generate.

def build():
    print(f"Building sidecar for {TARGET_TRIPLE}...")
    
    # Ensure binaries dir exists
    BINARIES_DIR.mkdir(parents=True, exist_ok=True)

    # Run PyInstaller
    # We use backend/server.py as entry point
    # We need to include src package
    # We might need to handle hidden imports or data files if config/logs usage requires it
    # BUT: Config is external (loaded from . or internal)
    
    cmd = [
        "pyinstaller",
        "--clean",
        "--noconfirm",
        "--name", EXECUTABLE_NAME,
        "--onefile",
        # "--windowed", # Uncomment if you don't want a console window on launch (debug useful though)
        "--distpath", str(BACKEND_DIR / "dist"),
        "--workpath", str(BACKEND_DIR / "build"),
        "--specpath", str(BACKEND_DIR),
        # Add paths
        "--paths", str(BACKEND_DIR),
        # Hidden imports often needed for uvicorn/fastapi/pydantic/langchain
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols",
        "--hidden-import", "uvicorn.protocols.http",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "sqlite3",
        "--hidden-import", "tiktoken_ext.openai_public",
        "--hidden-import", "tiktoken_ext",
        # Additional hidden imports for installer compatibility
        "--hidden-import", "huggingface_hub",
        "--hidden-import", "pydantic",
        "--hidden-import", "pydantic_core",
        "--hidden-import", "chromadb",
        "--hidden-import", "chromadb.config",
        "--hidden-import", "httpx",
        "--hidden-import", "httpcore",
        "--hidden-import", "psutil",
        # Collect submodules for complex packages
        "--collect-submodules", "langchain",
        "--collect-submodules", "langchain_core",
        "--collect-submodules", "langchain_community",
        "--collect-submodules", "chromadb",
        # Entry point
        str(BACKEND_DIR / "server.py")
    ]
    
    print(f"Running: {' '.join(cmd)}")
    subprocess.check_call(cmd)

    # Move to src-tauri/binaries
    src_bin = BACKEND_DIR / "dist" / (f"{EXECUTABLE_NAME}.exe" if sys.platform == "win32" else EXECUTABLE_NAME)
    dst_bin = BINARIES_DIR / FULL_EXECUTABLE_NAME
    
    if src_bin.exists():
        print(f"Moving {src_bin} to {dst_bin}")
        shutil.move(str(src_bin), str(dst_bin))
        print("Build success!")
    else:
        print("Error: Build artifact not found.")
        sys.exit(1)

if __name__ == "__main__":
    clean()
    build()
