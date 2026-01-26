from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel, Field


class SearchResult(BaseModel):
    title: str
    url: str
    snippet: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchEngine(ABC):
    """Abstract base class for search engines."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Name of the search engine (e.g. 'google', 'duckduckgo')."""
        pass

    @abstractmethod
    def search(self, query: str, **kwargs: Any) -> list[SearchResult]:
        """Perform a synchronous search."""
        pass

    @abstractmethod
    async def asearch(self, query: str, **kwargs: Any) -> list[SearchResult]:
        """Perform an asynchronous search."""
        pass
