import logging
from typing import Any

import chromadb

from .vector_store import VectorStore

logger = logging.getLogger(__name__)


class ChromaVectorStore(VectorStore):
    """
    ChromaDB-based implementation of the VectorStore interface.
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
    ):
        self.collection.upsert(
            ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas
        )

    def query(
        self,
        query_embeddings: list[list[float]],
        n_results: int,
        where: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.collection.query(
            query_embeddings=query_embeddings, n_results=n_results, where=where
        )

    def count(self) -> int:
        return self.collection.count()

    def delete(self, ids: list[str]):
        # Delete in batches to avoid ChromaDB limitations or memory spikes
        batch_size = 1000
        for i in range(0, len(ids), batch_size):
            batch_ids = ids[i : i + batch_size]
            self.collection.delete(ids=batch_ids)

    def get_oldest_ids(self, limit: int) -> list[str]:
        """
        Implementation for ChromaDB.
        NOTE: ChromaDB does not support server-side sorting by metadata fields in their basic GET API.
        To handle 10M events efficiently, we would ideally need a DB with indexing on 'created_ts'.
        As a compromise for ChromaDB, we fetch ONLY 'metadatas' and 'ids' in batches if possible,
        but since we need the GLOBAL oldest, we might still hit memory pressure.

        Refined approach for prototype: fetch in batches and maintain a min-heap or just sort
        if memory allows for just IDs + TS.
        """
        # Fetching all IDs and TS (Memory usage: 10M * (string_id_len + 8 bytes float))
        # For 10M items, if ID is 20 chars, that's roughly 280MB of raw data.
        # Python overhead will make it >1GB.
        # We fetch only what we need.

        # Improvement: Fetch in smaller chunks if Chroma supported it based on offset,
        # but Chroma's get() is limited.

        # Current practical limit for metadata-only fetch in RAM:
        data = self.collection.get(include=["metadatas"])
        if not data or not data["ids"]:
            return []

        items = []
        for i, meta in enumerate(data["metadatas"]):
            ts = meta.get("created_ts", 0.0) if meta else 0.0
            items.append((data["ids"][i], ts))

        # Sort by timestamp (oldest first)
        items.sort(key=lambda x: x[1])
        return [item[0] for item in items[:limit]]
