import logging
from fastapi import Security
from fastapi.security import APIKeyHeader

logger = logging.getLogger("tepora.server.api.security")

API_KEY_NAME = "x-api-key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def get_api_key(api_key_header: str = Security(api_key_header)):
    """
    Validate the API key from the request header.
    
    For local desktop application (127.0.0.1 binding only), authentication
    is always skipped. Future LAN/remote access would require explicit
    configuration to enable authentication.
    """
    # ローカルデスクトップアプリ前提のため、認証は常にスキップ
    # 将来LAN公開が必要な場合は TEPORA_REMOTE_MODE=true 等で明示的に有効化
    return None

