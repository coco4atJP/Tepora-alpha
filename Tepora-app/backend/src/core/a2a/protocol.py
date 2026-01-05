"""
A2A (Agent-to-Agent) Protocol Definition.

This module defines the standard message structure for communication between agents.
It is designed to be extensible for future internet-based agent communication.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class MessageType(str, Enum):
    """Types of A2A messages."""

    TASK = "task"  # A request to perform a task
    RESULT = "result"  # The result of a task
    ERROR = "error"  # An error occurred
    PING = "ping"  # Health check
    PONG = "pong"  # Health check response


@dataclass
class A2AMessage:
    """
    Standard A2A Message Structure.

    Attributes:
        id: Unique message ID (UUID v4)
        type: Message type (task, result, error, etc.)
        sender: ID/Name of the sender agent
        receiver: ID/Name of the receiver agent (or "*" for broadcast)
        content: The actual payload of the message
        timestamp: Unix timestamp of message creation
        reply_to: ID of the message this is replying to (optional)
        metadata: Additional protocol metadata (optional)
    """

    type: MessageType
    sender: str
    receiver: str
    content: dict[str, Any]
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)
    reply_to: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        """Serialize message to JSON string."""
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, json_str: str) -> A2AMessage:
        """Deserialize message from JSON string."""
        data = json.loads(json_str)
        # Convert string type to Enum
        if "type" in data:
            data["type"] = MessageType(data["type"])
        return cls(**data)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> A2AMessage:
        """Create from dictionary."""
        # Create a copy to avoid modifying the input
        d = data.copy()
        if "type" in d and isinstance(d["type"], str):
            d["type"] = MessageType(d["type"])
        return cls(**d)
