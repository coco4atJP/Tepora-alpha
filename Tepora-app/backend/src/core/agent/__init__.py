"""
Agent Module - Specialized Agent Interfaces

Provides:
- BaseAgent: Abstract interface for compiled graphs
- SkeletonAgent: Phase 3 placeholder implementation
- Predefined skeleton agents (coding, research)
- CustomAgentRegistry: GPTs/Gems-style custom agent management
"""

from .base import BaseAgent, SkeletonAgent, coding_agent, research_agent
from .registry import CustomAgentRegistry, custom_agent_registry

__all__ = [
    "BaseAgent",
    "SkeletonAgent",
    "coding_agent",
    "research_agent",
    "CustomAgentRegistry",
    "custom_agent_registry",
]
