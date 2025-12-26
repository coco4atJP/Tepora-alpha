import os
import logging
from fastapi import Security, HTTPException, status
from fastapi.security import APIKeyHeader
from src.core.config.loader import settings

logger = logging.getLogger("tepora.server.api.security")

API_KEY_NAME = "x-api-key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def get_api_key(api_key_header: str = Security(api_key_header)):
    """
    Validate the API key from the request header.
    Priority: TEPORA_API_KEY env var > config.yml security.api_key
    """
    expected_key = os.getenv("TEPORA_API_KEY") or settings.security.get("api_key")
    
    # If no key configured, allow in development mode only
    if not expected_key:
        if os.getenv("TEPORA_ENV") == "development":
            # logger.warning("API Key not configured, allowing access in development mode.") # Reduced noise
            return None
        else:
            logger.error("API Key not configured in production mode. Blocking request.")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Server security configuration error",
            )
        
    if api_key_header == expected_key:
        return api_key_header
        
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Could not validate credentials",
    )
