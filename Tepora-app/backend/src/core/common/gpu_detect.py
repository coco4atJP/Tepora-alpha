"""
GPU/CUDA Detection Utilities

OS-level GPU detection without heavy ML framework dependencies.
"""

import platform
import subprocess
import shutil
import logging
from functools import lru_cache

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def is_cuda_available() -> bool:
    """
    Detect CUDA availability using OS-level tools.
    
    This avoids heavy dependencies like PyTorch just for GPU detection.
    Uses nvidia-smi on Windows/Linux, which is installed with NVIDIA drivers.
    
    Returns:
        True if CUDA-capable GPU is available, False otherwise.
    """
    if platform.system() == "Darwin":
        # macOS doesn't have CUDA support
        return False
    
    # Check if nvidia-smi is available
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        logger.debug("nvidia-smi not found in PATH")
        return False
    
    try:
        result = subprocess.run(
            [nvidia_smi, "--query-gpu=gpu_name", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            logger.info(f"CUDA GPU detected: {result.stdout.strip().split(chr(10))[0]}")
            return True
        return False
    except subprocess.TimeoutExpired:
        logger.warning("nvidia-smi timed out")
        return False
    except FileNotFoundError:
        return False
    except Exception as e:
        logger.debug(f"CUDA detection failed: {e}")
        return False


@lru_cache(maxsize=1)
def get_cuda_version() -> str | None:
    """
    Get CUDA driver version using nvidia-smi.
    
    Returns:
        CUDA version string (e.g., "12.4") or None if not available.
    """
    if not is_cuda_available():
        return None
    
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return None
    
    try:
        result = subprocess.run(
            [nvidia_smi, "--query-gpu=driver_version", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            driver_version = result.stdout.strip().split("\n")[0]
            # Map driver version to CUDA version (approximate)
            # See: https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html
            try:
                major = int(driver_version.split(".")[0])
                if major >= 555:
                    return "12.4"
                elif major >= 545:
                    return "12.3"
                elif major >= 525:
                    return "12.0"
                elif major >= 515:
                    return "11.8"
                elif major >= 470:
                    return "11.4"
                else:
                    return "11.0"
            except (ValueError, IndexError):
                return "12.0"  # Default assumption
        return None
    except Exception as e:
        logger.debug(f"CUDA version detection failed: {e}")
        return None
