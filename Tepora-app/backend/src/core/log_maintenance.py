"""
Log maintenance utilities for Tepora.

Provides automatic cleanup of old log files to prevent disk space exhaustion.
"""
import logging
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)


def cleanup_old_logs(
    log_dir: Path,
    max_age_days: int = 7,
    patterns: list[str] | None = None
) -> int:
    """
    Remove log files older than max_age_days.
    
    Args:
        log_dir: Directory containing log files
        max_age_days: Maximum age in days before deletion
        patterns: Glob patterns to match (default: ["*.log"])
        
    Returns:
        Number of files deleted
    """
    if patterns is None:
        patterns = ["*.log"]
    
    if not log_dir.exists():
        logger.debug("Log directory does not exist: %s", log_dir)
        return 0
    
    cutoff = datetime.now() - timedelta(days=max_age_days)
    deleted_count = 0
    
    for pattern in patterns:
        for log_file in log_dir.glob(pattern):
            # Skip if not a file
            if not log_file.is_file():
                continue
                
            # Check modification time
            mtime = datetime.fromtimestamp(log_file.stat().st_mtime)
            if mtime < cutoff:
                try:
                    log_file.unlink()
                    deleted_count += 1
                    logger.info("Deleted old log file: %s (age: %s days)", 
                               log_file.name, (datetime.now() - mtime).days)
                except OSError as e:
                    logger.warning("Failed to delete log file %s: %s", log_file, e)
    
    if deleted_count > 0:
        logger.info("Cleaned up %d old log files from %s", deleted_count, log_dir)
    
    return deleted_count


def cleanup_llama_server_logs(log_dir: Path, max_files: int = 20) -> int:
    """
    Clean up llama_server_*.log files, keeping only the newest max_files.
    
    These log files accumulate with each server restart and can fill disk space.
    
    Args:
        log_dir: Directory containing log files
        max_files: Maximum number of files to keep per model type
        
    Returns:
        Number of files deleted
    """
    if not log_dir.exists():
        return 0
    
    deleted_count = 0
    
    # Group by model type (character_model, embedding_model, etc.)
    for model_type in ["character_model", "embedding_model", "executor_model"]:
        pattern = f"llama_server_{model_type}_*.log"
        files = sorted(
            log_dir.glob(pattern),
            key=lambda f: f.stat().st_mtime,
            reverse=True  # Newest first
        )
        
        # Delete files beyond max_files
        for old_file in files[max_files:]:
            try:
                old_file.unlink()
                deleted_count += 1
                logger.debug("Deleted excess llama log: %s", old_file.name)
            except OSError as e:
                logger.warning("Failed to delete %s: %s", old_file, e)
    
    if deleted_count > 0:
        logger.info("Cleaned up %d excess llama server log files", deleted_count)
    
    return deleted_count
