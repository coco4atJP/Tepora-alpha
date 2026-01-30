"""
Security utilities for path resolution and validation.
"""

from pathlib import Path


class SecurityUtils:
    @staticmethod
    def safe_path_join(base_path: str | Path, *paths: str) -> Path:
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

        if not final_path.is_relative_to(base):
            raise ValueError(f"Path traversal attempt detected: {final_path} is not within {base}")

        return final_path

    @staticmethod
    def validate_path_is_safe(path: str | Path, base_path: str | Path) -> bool:
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
            return target.is_relative_to(base)
        except Exception as e:
            # Import logger here to avoid circular imports if necessary, or use print if logger not available
            # But we can assume logger is configured in this project structure
            import logging

            logging.getLogger(__name__).debug("Path validation failed for '%s': %s", path, e)
            return False
