# agent_core/memory/memory_system.py
"""
ChromaDB-based MemorySystem implementation.

Features:
- Stores episodic events in a local ChromaDB collection.
- Stores summary (document), history (metadata), timestamp (metadata), and embedding.
- Uses embedding_provider.encode(...) to produce embeddings (expects a list-of-lists).
- Retrieval supports k-nearest by cosine similarity and a temporally-contiguous boost.
"""

import json
import logging
import time
from typing import Any

from .chroma_store import ChromaVectorStore
from .vector_store import VectorStore

logger = logging.getLogger(__name__)


class MemorySystem:
    def __init__(
        self,
        embedding_provider,
        db_path: str | None = None,
        collection_name: str = "tepora_memory",
        vector_store: VectorStore | None = None,
    ):
        """
        embedding_provider: object with .encode(List[str]) -> List[List[float]]
        db_path: path to the directory where ChromaDB data will be stored.
                 If None, defaults to CHROMA_DB_PATH / "default".
        collection_name: name of the collection to use.
        vector_store: Optional VectorStore implementation. If None, ChromaVectorStore is used.
        """
        # Lazy import to avoid circular dependency and allow DI override
        if db_path is None:
            from ..config import CHROMA_DB_PATH

            db_path = str(CHROMA_DB_PATH / "default")

        self.embedding_provider = embedding_provider
        if vector_store:
            self.store = vector_store
        else:
            self.store = ChromaVectorStore(db_path, collection_name)

        logger.info("MemorySystem initialized with %s", type(self.store).__name__)

    @property
    def collection(self):
        """Expose the underlying collection for EM-LLM direct access."""
        return self.store.collection

    def save_episode(
        self, summary: str, history_json: str, metadata: dict[str, Any] | None = None
    ) -> str | None:
        """
        Save an episode and compute/store its embedding.

        Args:
            summary: Episode summary text.
            history_json: JSON-encoded history.
            metadata: Optional additional metadata.

        Returns:
            Generated episode ID, or None if summary was empty.
        """
        if not summary:
            logger.warning("Attempted to save an episode with an empty summary. Skipping.")
            return None
        try:
            doc_id = (
                metadata.get("id")
                if metadata and "id" in metadata
                else str(time.time()).replace(".", "")
            )
            embedding = self.embedding_provider.encode([summary])[0]

            # Prepare metadata for storage
            episode_metadata = {
                "created_ts": time.time(),
                "history_json": history_json,
                "metadata_json": json.dumps(metadata or {}),
            }

            self.store.add(
                ids=[str(doc_id)],
                embeddings=[embedding],
                documents=[summary],
                metadatas=[episode_metadata],
            )
            logger.info("Saved episode %s to MemorySystem (summary len=%d)", doc_id, len(summary))
            return doc_id
        except Exception:
            logger.exception("Failed to save episode to MemorySystem")
            raise

    def retrieve(
        self,
        query: str,
        k: int = 5,
        temporality_boost: float = 0.15,
        query_embedding_override: list[float] | None = None,
        where_filter: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Retrieve top-k episodes for query.

        Args:
            query: Query text.
            k: Number of results to return.
            temporality_boost: Boost factor for recency.
            query_embedding_override: Optional pre-computed embedding.
            where_filter: Optional metadata filter.

        Returns:
            List of episode dictionaries sorted by relevance score.
        """
        if not query and query_embedding_override is None and where_filter is None:
            return []
        try:
            if query_embedding_override:
                query_embedding = [query_embedding_override]
            else:
                query_embedding = self.embedding_provider.encode([query])

            if query_embedding:
                results = self.store.query(
                    query_embeddings=query_embedding, n_results=k, where=where_filter
                )
            else:
                # Store-level search without embedding might return different format,
                # but our VectorStore.query expects embeddings.
                # If we need 'get' by metadata only, we should add it to VectorStore.
                # For now, keeping it consistent.
                return []

            if not results or not isinstance(results, dict):
                return []

            ids_group = results.get("ids") or []
            if not ids_group:
                return []
            if isinstance(ids_group[0], list):
                ids = ids_group[0]
            else:
                ids = ids_group
            if not ids:
                return []

            scored = []
            raw_distances = results.get("distances")
            distances = None
            if raw_distances is not None:
                if isinstance(raw_distances, list):
                    if raw_distances and isinstance(raw_distances[0], list):
                        distances = raw_distances[0]
                    else:
                        distances = raw_distances
                elif hasattr(raw_distances, "__len__"):
                    distances = raw_distances

            if distances is not None and len(distances) > 0:
                distances = list(distances)
            else:
                distances = [0.0] * len(ids)

            if len(distances) < len(ids):
                distances = list(distances) + [0.0] * (len(ids) - len(distances))

            metadatas = results.get("metadatas") or []
            if metadatas and isinstance(metadatas[0], list):
                metadatas = metadatas[0] or []
            documents = results.get("documents") or []
            if documents and isinstance(documents[0], list):
                documents = documents[0] or []
            if len(documents) < len(ids):
                documents = list(documents) + [""] * (len(ids) - len(documents))

            for i in range(len(ids)):
                # Cosine distance to similarity: sim = 1 - dist
                sim = 1.0 - distances[i]
                meta = metadatas[i] if i < len(metadatas) else {}
                if meta is None or not isinstance(meta, dict):
                    meta = {}
                metadata_json = meta.get("metadata_json", "{}")
                history_json = meta.get("history_json", "{}")
                created_ts = meta.get("created_ts", 0.0)
                try:
                    decoded_metadata = (
                        json.loads(metadata_json) if isinstance(metadata_json, str) else {}
                    )
                except json.JSONDecodeError as exc:
                    logger.debug(
                        "Failed to decode metadata_json for id %s: %s", ids[i], exc, exc_info=True
                    )
                    decoded_metadata = {}
                scored.append(
                    {
                        "id": ids[i],
                        "ts": created_ts,
                        "summary": documents[i],
                        "history_json": history_json,
                        "metadata": decoded_metadata,
                        "score": sim,
                    }
                )

            if not scored:
                return []

            # Apply temporality boost
            if temporality_boost > 0 and len(scored) > 1:
                max_ts = max(x["ts"] for x in scored)
                if max_ts > 0:
                    for item in scored:
                        recency = item["ts"] / max_ts
                        item["score"] += temporality_boost * recency

            scored.sort(key=lambda x: x["score"], reverse=True)
            topk = scored[:k]
            logger.info(
                "Retrieved %d episodes from MemorySystem (k=%d). Top score=%s",
                len(topk),
                k,
                topk[0]["score"] if topk else None,
            )
            return topk
        except Exception as e:
            logger.error("Failed during retrieval: %s", e, exc_info=True)
            raise

    def count(self) -> int:
        """Return the number of episodes in the collection."""
        return self.store.count()

    def cleanup_old_events(self, max_age_days: int = 30, max_events: int = 10000000) -> None:
        """
        Deletes older events exceeding the limit.
        Optimized by delegating the 'oldest' identification to the VectorStore implementation.
        """
        try:
            current_count = self.count()
            if current_count <= max_events:
                logger.info(
                    "Cleanup not needed. Current events (%d) <= limit (%d).",
                    current_count,
                    max_events,
                )
                return

            num_to_delete = current_count - max_events
            logger.info("Cleanup required. Identifying %d oldest events.", num_to_delete)

            # Delegate to store to get only IDs to delete
            ids_to_delete = self.store.get_oldest_ids(num_to_delete)

            if ids_to_delete:
                self.store.delete(ids_to_delete)
                logger.info("Cleaned up %d oldest events.", len(ids_to_delete))
            else:
                logger.info("No events found to delete for cleanup.")

        except Exception as e:
            logger.error("Error during memory cleanup: %s", e, exc_info=True)

    def retrieve_similar_episodes(self, query: str, k: int = 5) -> list[dict]:
        return self.retrieve(query, k)

    def close(self) -> None:
        try:
            self.store.close()
        except Exception as e:
            logger.warning("Failed to close vector store: %s", e, exc_info=True)
