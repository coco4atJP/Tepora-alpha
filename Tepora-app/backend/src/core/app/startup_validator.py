"""
Startup configuration validation.

Contains validation logic that should be run BEFORE
attempting to initialize heavy resources.
"""

import logging
import uuid
from pathlib import Path

from ..config import CHROMA_DB_PATH

logger = logging.getLogger(__name__)


def validate_startup_config(config, project_root: Path) -> None:
    """
    Validate startup configuration.

    Checks for:
    - GGUF model file existence
    - EM-LLM config type and value integrity
    - ChromaDB path accessibility

    Args:
        config: The application settings object (pydantic model)
        project_root: The root path of the project

    Raises:
        ValueError: If validation fails.

    Should be called BEFORE creating TeporaApp.
    """
    errors: list[str] = []

    # Validate GGUF Models
    # Note: Pydantic schema ensures types, we only validate existence/constraints.
    models_config = config.models_gguf
    if not models_config:
        logger.warning(
            "models_gguf section is missing or empty in configuration (allowed before initial setup)"
        )
    else:
        for model_key, model_cfg in models_config.items():
            # model_cfg is ModelGGUFConfig object

            model_path_str = model_cfg.path
            if not model_path_str:
                errors.append(f"[models_gguf.{model_key}.path] is missing")
                continue

            # Resolve path (Naive check relative to project root or absolute)
            model_path = Path(model_path_str)
            if not model_path.is_absolute():
                model_path = project_root / model_path_str

            if not model_path.exists():
                # Warning only: Allow startup before initial model download
                logger.warning(
                    "[models_gguf.%s.path] Model file not found at: %s (Key: %s)",
                    model_key,
                    model_path,
                    model_key,
                )
            elif not model_path.is_file():
                errors.append(f"[models_gguf.{model_key}.path] Path is not a file: {model_path}")

            # Validate port
            port = model_cfg.port
            if port is not None:
                if not isinstance(port, int) or not (1024 <= port <= 65535):
                    errors.append(
                        f"[models_gguf.{model_key}.port] must be an integer between 1024 and 65535"
                    )

    # Validate EM-LLM Config
    # Config is already validated by Pydantic schema types.
    # We only check logical constraints (min < max, range).
    em_config = config.em_llm
    if not em_config:
        errors.append("em_llm section is missing in configuration")
    else:
        if not (0.0 <= em_config.surprise_gamma <= 1.0):
            errors.append("[em_llm.surprise_gamma] must be between 0.0 and 1.0")

        if em_config.min_event_size > em_config.max_event_size:
            errors.append("[em_llm.min_event_size] cannot be greater than [em_llm.max_event_size]")

    # Validate ChromaDB Path
    # Use CHROMA_DB_PATH from config (unified USER_DATA_DIR)
    chroma_db_path = CHROMA_DB_PATH / "em_llm"
    try:
        # Try to create the directory if it doesn't exist
        chroma_db_path.mkdir(parents=True, exist_ok=True)
        # Test write access by creating a temp file.
        # Note: In some sandboxed environments file deletion can be restricted, so we treat
        # "can create/write" as the source of truth and only best-effort clean up.
        test_file = chroma_db_path / f".write_test_{uuid.uuid4().hex}"
        test_file.write_text("ok", encoding="utf-8")
        try:
            test_file.unlink()
        except OSError:
            logger.debug("Could not remove write test file: %s", test_file, exc_info=True)
    except PermissionError:
        errors.append(f"[ChromaDB] No write permission for directory: {chroma_db_path}")
    except OSError as e:
        errors.append(f"[ChromaDB] Cannot access directory {chroma_db_path}: {e}")

    # Raise all errors at once
    if errors:
        error_message = "Startup validation failed:\n  - " + "\n  - ".join(errors)
        logger.critical(error_message)
        raise ValueError(error_message)
