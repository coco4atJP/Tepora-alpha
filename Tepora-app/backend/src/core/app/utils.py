"""
Application utility functions.

This module provides helper functions for the main application:
- Input sanitization
"""

from __future__ import annotations

import logging
import re
from .. import config

logger = logging.getLogger(__name__)


def sanitize_user_input(user_input: str, max_length: int = None) -> str:
    """
    Sanitize user input to mitigate potential prompt injection attacks.
    
    Args:
        user_input: Raw user input
        max_length: Maximum allowed input length (defaults to config.MAX_INPUT_LENGTH)
        
    Returns:
        Sanitized input string
        
    Raises:
        ValueError: If input exceeds max_length
    """
    if max_length is None:
        max_length = config.MAX_INPUT_LENGTH
    
    if len(user_input) > max_length:
        raise ValueError(f"Input too long: {len(user_input)} > {max_length}")
    
    # Detect dangerous patterns that may attempt system prompt injection
    sanitized_input = user_input
    for pattern in config.DANGEROUS_PATTERNS:
        if re.search(pattern, sanitized_input, re.IGNORECASE):
            logger.warning(
                "Potential prompt injection attempt detected; input will be sanitized. "
                "pattern=%s snippet='%s...'",
                pattern,
                sanitized_input[:100]
            )
            sanitized_input = re.sub(pattern, "[filtered]", sanitized_input, flags=re.IGNORECASE)
    
    if sanitized_input != user_input:
        sanitized_input += (
            "\n\n[Notice: parts of your message were filtered due to unsafe instructions. "
            "Please rephrase if needed.]"
        )
    
    return sanitized_input
