import logging
from typing import Any, cast

import chromadb

from .vector_store import VectorStore

logger = logging.getLogger(__name__)


class ChromaVectorStore(VectorStore):
    """
    ChromaDB-based implementation of the VectorStore interface.

    This store uses a persistent ChromaDB client to manage vector embeddings
    with cosine similarity for retrieval operations.

    Warning:
        ``get_oldest_ids`` fetches all metadata into memory. This may cause
        memory pressure with very large collections (>1M items).

    Example:
        >>> store = ChromaVectorStore("/path/to/db", "my_collection")
        >>> store.add(ids=["1"], embeddings=[[0.1, 0.2]], documents=["hello"], metadatas=[{}])
        >>> results = store.query([[0.1, 0.2]], n_results=5)
    """

    def __init__(self, db_path: str, collection_name: str):
        self.db_path = db_path
        self.collection_name = collection_name
        self.client = chromadb.PersistentClient(path=self.db_path)
        self.collection = self.client.get_or_create_collection(
            name=self.collection_name, metadata={"hnsw:space": "cosine"}
        )

    def add(
        self,
        ids: list[str],
        embeddings: list[list[float]],
        documents: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        self.collection.upsert(
            ids=ids,
            embeddings=cast(Any, embeddings),
            documents=documents,
            metadatas=cast(Any, metadatas),
        )

    def query(
        self,
        query_embeddings: list[list[float]],
        n_results: int,
        where: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        result = self.collection.query(
            query_embeddings=cast(Any, query_embeddings), n_results=n_results, where=where
        )
        return dict(result)

    def count(self) -> int:
        return int(self.collection.count())

    def delete(self, ids: list[str]) -> None:
        # Delete in batches to avoid ChromaDB limitations or memory spikes
        batch_size = 1000
        for i in range(0, len(ids), batch_size):
            batch_ids = ids[i : i + batch_size]
            self.collection.delete(ids=batch_ids)

    def get_oldest_ids(self, limit: int) -> list[str]:
        """
        Get the IDs of the oldest events by timestamp.

        Warning:
            ChromaDB does not support server-side sorting by metadata fields.
            This method fetches all IDs and timestamps into memory, which may
            cause memory pressure for large collections (>1M items).

        Args:
            limit: Maximum number of IDs to return.

        Returns:
            List of IDs for the oldest events.
        """
        # Fetching all IDs and TS (Memory usage: 10M * (string_id_len + 8 bytes float))
        # For 10M items, if ID is 20 chars, that's roughly 280MB of raw data.
        # Python overhead will make it >1GB.
        # We fetch only what we need.

        # Improvement: Fetch in smaller chunks if Chroma supported it based on offset,
        # but Chroma's get() is limited.

        # Current practical limit for metadata-only fetch in RAM:
        data = self.collection.get(include=["metadatas"])
        ids = list(data.get("ids") or [])
        metadatas = data.get("metadatas") or []
        if not ids:
            return []

        items: list[tuple[str, float]] = []
        for i, meta in enumerate(metadatas):
            if i >= len(ids):
                break
            ts_raw = meta.get("created_ts") if meta else None
            ts = 0.0
            if isinstance(ts_raw, (int, float)):
                ts = float(ts_raw)
            elif isinstance(ts_raw, str):
                try:
                    ts = float(ts_raw)
                except ValueError:
                    ts = 0.0
            items.append((ids[i], ts))

        # Sort by timestamp (oldest first)
        items.sort(key=lambda x: x[1])
        return [item[0] for item in items[:limit]]

    def close(self) -> None:
        """Close the ChromaDB client (no-op for PersistentClient)."""
        pass
