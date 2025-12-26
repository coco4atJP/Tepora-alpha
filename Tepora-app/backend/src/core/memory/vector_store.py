from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional

class VectorStore(ABC):
    """
    Abstract base class for vector storage operations.
    Decouples the memory system from specific vector database implementations.
    """

    @abstractmethod
    def add(self, ids: List[str], embeddings: List[List[float]], documents: List[str], metadatas: List[Dict[str, Any]]):
        """Add or update vectors in the store."""
        pass

    @abstractmethod
    def query(self, query_embeddings: List[List[float]], n_results: int, where: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Query the store for nearest neighbors."""
        pass

    @abstractmethod
    def count(self) -> int:
        """Return the total number of items in the store."""
        pass

    @abstractmethod
    def delete(self, ids: List[str]):
        """Delete items by ID."""
        pass

    @abstractmethod
    def get_oldest_ids(self, limit: int) -> List[str]:
        """
        Fetch the IDs of the oldest items based on creation timestamp.
        Implementation should be optimized to avoid loading full metadata for all items.
        """
        pass
