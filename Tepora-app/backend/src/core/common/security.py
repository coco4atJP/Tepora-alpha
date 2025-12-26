"""
Security utilities for path resolution and validation.
"""
from pathlib import Path
from typing import Union

class SecurityUtils:
    @staticmethod
    def safe_path_join(base_path: Union[str, Path], *paths: str) -> Path:
        """
        Safely joins paths and ensures the resulting path is within the base directory.
        Prevents directory traversal attacks.
        
        Args:
            base_path: The trusted base directory.
            *paths: Path components to join.
            
        Returns:
            The resolved absolute path.
            
        Raises:
            ValueError: If the resolved path attempts to traverse outside the base path.
        """
        base = Path(base_path).resolve()
        final_path = base.joinpath(*paths).resolve()
        
        if not str(final_path).startswith(str(base)):
            raise ValueError(f"Path traversal attempt detected: {final_path} is not within {base}")
            
        return final_path

    @staticmethod
    def validate_path_is_safe(path: Union[str, Path], base_path: Union[str, Path]) -> bool:
        """
        Checks if a path is within a base directory.
        
        Args:
            path: The path to check.
            base_path: The trusted base directory.
            
        Returns:
            True if safe, False otherwise.
        """
        try:
            base = Path(base_path).resolve()
            target = Path(path).resolve()
            return str(target).startswith(str(base))
        except Exception:
            return False
