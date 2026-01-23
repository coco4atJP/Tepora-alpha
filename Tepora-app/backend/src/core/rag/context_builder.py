"""
RAG Context Builder - Similarity-based Context Construction

Builds RAG context by computing embeddings and finding relevant chunks.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

logger = logging.getLogger(__name__)


class EmbeddingModel(Protocol):
    """Protocol for embedding models."""

    def embed_query(self, text: str) -> list[float]: ...
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...


class RAGContextBuilder:
    """
    Builds RAG context from chunks using embedding similarity.

    Computes embeddings for query and chunks, then selects
    the most relevant chunks based on cosine similarity.

    Usage:
        builder = RAGContextBuilder()

        context = builder.build_context(
            chunk_texts=["chunk1", "chunk2"],
            chunk_sources=["source1", "source2"],
            query="user question",
            embedding_model=embeddings,
        )
    """

    def __init__(
        self,
        top_k: int = 5,
        max_context_chars: int = 3000,
        embedding_batch_size: int = 32,
    ):
        """
        Initialize context builder.

        Args:
            top_k: Number of top chunks to include
            max_context_chars: Maximum characters in final context
            embedding_batch_size: Batch size for embedding computation
        """
        self.top_k = top_k
        self.max_context_chars = max_context_chars
        self.embedding_batch_size = embedding_batch_size

    def build_context(
        self,
        chunk_texts: list[str],
        chunk_sources: list[str],
        query: str,
        embedding_model: Any,
    ) -> str:
        """
        Build RAG context from chunks using embedding similarity.

        Args:
            chunk_texts: List of text chunks
            chunk_sources: Corresponding source labels
            query: User query for similarity matching
            embedding_model: Model with embed_query/embed_documents methods

        Returns:
            Formatted context string with source citations
        """
        no_context = "No relevant content found from web results or attachments."

        if not chunk_texts:
            return no_context

        # Validate embedding model interface
        if not self._validate_embedding_model(embedding_model):
            logger.error("Embedding model does not expose embed_query/embed_documents.")
            return "Embedding model unavailable for RAG."

        # Compute query embedding
        try:
            query_embedding = np.array(embedding_model.embed_query(query))
            if query_embedding.ndim == 1:
                query_embedding = query_embedding.reshape(1, -1)
        except Exception as exc:
            logger.error("Failed to embed query: %s", exc)
            return no_context

        # Compute chunk embeddings in batches
        embedded_chunks = self._embed_chunks_batched(
            chunk_texts=chunk_texts,
            chunk_sources=chunk_sources,
            embedding_model=embedding_model,
        )

        if not embedded_chunks["embeddings"]:
            logger.warning("No chunk embeddings computed. Skipping similarity search.")
            return no_context

        # Compute similarities and select top chunks
        chunk_embeddings = np.array(embedded_chunks["embeddings"])
        similarities = cosine_similarity(query_embedding, chunk_embeddings)[0]

        top_k = min(self.top_k, len(embedded_chunks["texts"]))
        top_indices = similarities.argsort()[-top_k:][::-1]

        # Build context with source citations
        selected_contexts = [
            f"[Source: {embedded_chunks['sources'][i]}]\n{embedded_chunks['texts'][i]}"
            for i in top_indices
        ]
        rag_context = "\n\n---\n\n".join(selected_contexts)

        # Truncate if too long
        if len(rag_context) > self.max_context_chars:
            rag_context = (
                rag_context[: self.max_context_chars] + "\n... (truncated for context limit)"
            )
            logger.info("RAG context truncated to %d chars", self.max_context_chars)

        logger.info(
            "Extracted %d most relevant chunks from combined sources.",
            len(selected_contexts),
        )

        return rag_context

    def _validate_embedding_model(self, model: Any) -> bool:
        """Check if model has required embedding methods."""
        return all(hasattr(model, attr) for attr in ("embed_query", "embed_documents"))

    def _embed_chunks_batched(
        self,
        chunk_texts: list[str],
        chunk_sources: list[str],
        embedding_model: Any,
    ) -> dict[str, list]:
        """Embed chunks in batches, handling failures gracefully."""
        result: dict[str, list] = {
            "texts": [],
            "sources": [],
            "embeddings": [],
        }

        for batch_start in range(0, len(chunk_texts), self.embedding_batch_size):
            batch_end = batch_start + self.embedding_batch_size
            batch_texts = chunk_texts[batch_start:batch_end]
            batch_sources = chunk_sources[batch_start:batch_end]

            try:
                batch_embeddings = embedding_model.embed_documents(batch_texts)
            except Exception as exc:
                logger.error(
                    "Failed to embed batch %d-%d: %s",
                    batch_start,
                    batch_end - 1,
                    exc,
                )
                continue

            if not batch_embeddings:
                logger.warning(
                    "Embedding batch %d-%d returned no vectors. Skipping.",
                    batch_start,
                    batch_end - 1,
                )
                continue

            result["embeddings"].extend(batch_embeddings)
            result["texts"].extend(batch_texts)
            result["sources"].extend(batch_sources)

        return result
