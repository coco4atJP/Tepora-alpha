from abc import ABC, abstractmethod
from typing import Any


class VectorStore(ABC):
    """
    Abstract base class for vector storage operations.
    Decouples the memory system from specific vector database implementations.
    """

    @abstractmethod
    def add(
        self,
        ids: list[str],
        embeddings: list[list[float]],
        documents: list[str],
        metadatas: list[dict[str, Any]],
    ):
        """Add or update vectors in the store."""
        pass

    @abstractmethod
    def query(
        self,
        query_embeddings: list[list[float]],
        n_results: int,
        where: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Query the store for nearest neighbors."""
        pass

    @abstractmethod
    def count(self) -> int:
        """Return the total number of items in the store."""
        pass

    @abstractmethod
    def delete(self, ids: list[str]):
        """Delete items by ID."""
        pass

    @abstractmethod
    def get_oldest_ids(self, limit: int) -> list[str]:
        """
        Fetch the IDs of the oldest items based on creation timestamp.
        Implementation should be optimized to avoid loading full metadata for all items.
        """
        pass

    def close(self) -> None:
        """Optional cleanup hook for concrete store implementations."""
        return None
