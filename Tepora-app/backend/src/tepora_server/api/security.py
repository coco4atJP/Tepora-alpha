"""
API Security Module - Session Token Authentication

Provides session token generation and verification for API endpoints.
Token is generated at startup and shared with Tauri frontend via:
1. Environment variable TEPORA_SESSION_TOKEN (preferred, set by Tauri)
2. File-based fallback (~/.tepora/.session_token)
"""

import logging
import os
import secrets
from pathlib import Path

from fastapi import HTTPException, Security, status
from fastapi.security import APIKeyHeader

logger = logging.getLogger("tepora.server.api.security")

API_KEY_NAME = "x-api-key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

# Module-level session token (initialized at startup)
_session_token: str | None = None


def initialize_session_token() -> str:
    """
    Initialize session token at server startup.

    Token source priority:
    1. Environment variable TEPORA_SESSION_TOKEN (set by Tauri via OS Keychain)
    2. File-based fallback (for development or non-Tauri usage)

    Returns:
        The session token string
    """
    global _session_token

    # Priority 1: Environment variable (Tauri sets this from OS Keychain)
    env_token = os.environ.get("TEPORA_SESSION_TOKEN")
    if env_token:
        _session_token = env_token
        logger.info("Session token loaded from environment variable")
        return _session_token

    # Priority 2: File-based fallback
    _session_token = secrets.token_urlsafe(32)
    token_path = Path.home() / ".tepora" / ".session_token"
    try:
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(_session_token)
        # Set restrictive permissions (owner read/write only)
        if os.name != "nt":  # Unix-like systems
            token_path.chmod(0o600)
        logger.info("Session token generated and saved to %s", token_path)
    except OSError as e:
        logger.warning("Could not save session token to file: %s", e)

    return _session_token


def get_session_token() -> str | None:
    """Get the current session token (for internal use)."""
    return _session_token


async def get_api_key(api_key_header: str = Security(api_key_header)) -> str:
    """
    Validate the API key from the request header.

    This is used as a FastAPI dependency for protected endpoints.

    Raises:
        HTTPException: 503 if server not initialized, 401 if invalid token
    """
    if _session_token is None:
        logger.error("API key validation attempted before initialization")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server not initialized",
        )

    if not api_key_header or api_key_header != _session_token:
        logger.warning("Invalid or missing API key in request")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
            headers={"WWW-Authenticate": f'ApiKey realm="{API_KEY_NAME}"'},
        )

    return api_key_header


async def get_api_key_optional(
    api_key_header: str = Security(api_key_header),
) -> str | None:
    """
    Optional API key validation - returns None instead of raising if invalid.

    Use this for endpoints that should work with or without authentication,
    but may provide different behavior based on authentication status.
    """
    if _session_token is None or not api_key_header:
        return None

    if api_key_header == _session_token:
        return api_key_header

    return None
