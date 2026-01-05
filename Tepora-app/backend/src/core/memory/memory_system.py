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

        logger.info(f"MemorySystem initialized with {type(self.store).__name__}")

    @property
    def collection(self):
        """Expose the underlying collection for EM-LLM direct access."""
        return self.store.collection

    def save_episode(self, summary: str, history_json: str, metadata: dict[str, Any] | None = None):
        """
        Save an episode and compute/store its embedding.
        Returns generated id.
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
                ids=[doc_id],
                embeddings=[embedding],
                documents=[summary],
                metadatas=[episode_metadata],
            )
            logger.info(f"Saved episode {doc_id} to MemorySystem (summary len={len(summary)})")
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
    ):
        """
        Retrieve top-k episodes for query.
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

            if not results or not results["ids"] or not results["ids"][0]:
                return []

            scored = []
            ids = results["ids"][0]
            raw_distances = results.get("distances")
            if raw_distances and raw_distances[0] is not None:
                distances = raw_distances[0]
            else:
                distances = [0.0] * len(ids)

            if len(distances) < len(ids):
                distances = list(distances) + [0.0] * (len(ids) - len(distances))

            metadatas = results["metadatas"][0]
            documents = results["documents"][0]

            for i in range(len(ids)):
                # Cosine distance to similarity: sim = 1 - dist
                sim = 1.0 - distances[i]
                meta = metadatas[i]
                scored.append(
                    {
                        "id": ids[i],
                        "ts": meta.get("created_ts", 0.0),
                        "summary": documents[i],
                        "history_json": meta.get("history_json", "{}"),
                        "metadata": json.loads(meta.get("metadata_json", "{}")),
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
                f"Retrieved {len(topk)} episodes from MemorySystem (k={k}). Top score={topk[0]['score'] if topk else None}"
            )
            return topk
        except Exception as e:
            logger.error(f"Failed during retrieval: {e}", exc_info=True)
            raise

    def count(self):
        """Returns the number of episodes in the collection."""
        return self.store.count()

    def cleanup_old_events(self, max_age_days: int = 30, max_events: int = 10000000):
        """
        Deletes older events exceeding the limit.
        Optimized by delegating the 'oldest' identification to the VectorStore implementation.
        """
        try:
            current_count = self.count()
            if current_count <= max_events:
                logger.info(
                    f"Cleanup not needed. Current events ({current_count}) <= limit ({max_events})."
                )
                return

            num_to_delete = current_count - max_events
            logger.info(f"Cleanup required. Identifying {num_to_delete} oldest events.")

            # Delegate to store to get only IDs to delete
            ids_to_delete = self.store.get_oldest_ids(num_to_delete)

            if ids_to_delete:
                self.store.delete(ids_to_delete)
                logger.info(f"Cleaned up {len(ids_to_delete)} oldest events.")
            else:
                logger.info("No events found to delete for cleanup.")

        except Exception as e:
            logger.error(f"Error during memory cleanup: {e}", exc_info=True)

    def retrieve_similar_episodes(self, query: str, k: int = 5) -> list[dict]:
        return self.retrieve(query, k)

    def close(self):
        pass
