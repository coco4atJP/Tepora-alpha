"""
PII (Personally Identifiable Information) Redactor Utility.

Provides functions to detect and redact sensitive personal information
from text before it is sent to external services.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import Final

logger = logging.getLogger(__name__)


# PII patterns for detection (compiled for performance)
PII_PATTERNS: Final[list[tuple[str, re.Pattern[str]]]] = [
    # Email addresses
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    # Phone numbers (Japanese format)
    ("phone_jp", re.compile(r"\b0\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{4}\b")),
    # Phone numbers (international format)
    ("phone_intl", re.compile(r"\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,4}\b")),
    # Credit card numbers (basic pattern)
    ("credit_card", re.compile(r"\b(?:\d{4}[-.\s]?){3}\d{4}\b")),
    # Japanese postal codes
    ("postal_jp", re.compile(r"\b\d{3}[-]?\d{4}\b")),
    # Social Security Numbers (US format)
    ("ssn_us", re.compile(r"\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b")),
    # Japanese My Number (12 digits)
    ("my_number_jp", re.compile(r"\b\d{12}\b")),
    # IP addresses (IPv4)
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
]

POSTAL_JP_CONTEXT_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"(?:\u3012|\u90f5\u4fbf\u756a\u53f7|\u90f5\u4fbf|postal|postcode|post\s*code|zip)",
    re.IGNORECASE,
)
POSTAL_JP_CONTEXT_WINDOW: Final[int] = 12

# Replacement placeholder for redacted content
REDACT_PLACEHOLDER = "[REDACTED]"
REDACT_PLACEHOLDER_BY_TYPE: Final[dict[str, str]] = {
    "email": "[REDACTED_EMAIL]",
    "phone_jp": "[REDACTED_PHONE]",
    "phone_intl": "[REDACTED_PHONE]",
    "credit_card": "[REDACTED_CREDIT_CARD]",
    "postal_jp": "[REDACTED_POSTAL]",
    "ssn_us": "[REDACTED_SSN]",
    "my_number_jp": "[REDACTED_MY_NUMBER]",
    "ipv4": "[REDACTED_IP]",
}


def _normalize_digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def _passes_luhn_check(number: str) -> bool:
    if not number.isdigit():
        return False

    total = 0
    for index, char in enumerate(reversed(number)):
        digit = int(char)
        if index % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit

    return total % 10 == 0


def _is_valid_credit_card_match(match: re.Match[str]) -> bool:
    digits = _normalize_digits(match.group(0))
    return 13 <= len(digits) <= 19 and _passes_luhn_check(digits)


def _has_postal_context(match: re.Match[str]) -> bool:
    text = match.string
    start = match.start()
    end = match.end()
    window_start = max(0, start - POSTAL_JP_CONTEXT_WINDOW)
    window_end = min(len(text), end + POSTAL_JP_CONTEXT_WINDOW)
    return bool(POSTAL_JP_CONTEXT_PATTERN.search(text[window_start:window_end]))


def _redact_with_predicate(
    text: str,
    pattern: re.Pattern[str],
    predicate: Callable[[re.Match[str]], bool],
    placeholder: str,
) -> tuple[str, int]:
    count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal count
        if predicate(match):
            count += 1
            return placeholder
        return match.group(0)

    return pattern.sub(replace, text), count


def _resolve_placeholder_map(
    placeholder_map: dict[str, str] | None,
    use_typed_placeholders: bool,
) -> dict[str, str] | None:
    if not use_typed_placeholders:
        return placeholder_map

    resolved = dict(REDACT_PLACEHOLDER_BY_TYPE)
    if placeholder_map:
        resolved.update(placeholder_map)
    return resolved


def _get_placeholder(
    pattern_name: str,
    default_placeholder: str,
    placeholder_map: dict[str, str] | None,
) -> str:
    if placeholder_map and pattern_name in placeholder_map:
        return placeholder_map[pattern_name]
    return default_placeholder


def redact_pii(
    text: str,
    *,
    enabled: bool = True,
    placeholder: str = REDACT_PLACEHOLDER,
    placeholder_map: dict[str, str] | None = None,
    use_typed_placeholders: bool = False,
    log_redactions: bool = True,
) -> tuple[str, int]:
    """
    Redact personally identifiable information from text.

    Args:
        text: Input text to process
        enabled: Whether PII redaction is enabled
        placeholder: Default placeholder string for redacted content
        placeholder_map: Optional per-pattern placeholder overrides
        use_typed_placeholders: Use built-in placeholders keyed by PII type
        log_redactions: Emit debug/info logs about redactions

    Returns:
        Tuple of (redacted_text, count_of_redactions)
    """
    if not enabled or not text:
        return text, 0

    redacted_text = text
    total_redactions = 0

    effective_placeholder_map = _resolve_placeholder_map(placeholder_map, use_typed_placeholders)

    for pattern_name, pattern in PII_PATTERNS:
        placeholder_value = _get_placeholder(pattern_name, placeholder, effective_placeholder_map)
        if pattern_name == "credit_card":
            redacted_text, count = _redact_with_predicate(
                redacted_text,
                pattern,
                _is_valid_credit_card_match,
                placeholder_value,
            )
        elif pattern_name == "postal_jp":
            redacted_text, count = _redact_with_predicate(
                redacted_text,
                pattern,
                _has_postal_context,
                placeholder_value,
            )
        else:
            matches = pattern.findall(redacted_text)
            count = len(matches)
            if count > 0:
                redacted_text = pattern.sub(placeholder_value, redacted_text)

        if count > 0:
            total_redactions += count
            if log_redactions:
                logger.debug("Redacted %d instances of %s pattern", count, pattern_name)

    if log_redactions and total_redactions > 0:
        logger.info("PII redaction: removed %d sensitive items from text", total_redactions)

    return redacted_text, total_redactions


def contains_pii(text: str) -> bool:
    """
    Check if text contains any PII patterns.

    Args:
        text: Input text to check

    Returns:
        True if PII is detected, False otherwise
    """
    if not text:
        return False

    for pattern_name, pattern in PII_PATTERNS:
        if pattern_name == "credit_card":
            for match in pattern.finditer(text):
                if _is_valid_credit_card_match(match):
                    return True
            continue
        if pattern_name == "postal_jp":
            for match in pattern.finditer(text):
                if _has_postal_context(match):
                    return True
            continue
        if pattern.search(text):
            return True

    return False
