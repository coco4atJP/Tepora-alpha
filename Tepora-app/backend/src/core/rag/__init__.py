"""
RAG Module - Retrieval-Augmented Generation

Provides RAG capabilities including:
- RAGEngine: Chunk collection from web and attachments
- RAGContextBuilder: Embedding-based context construction
- SourceManager: Document source management with session filtering
"""

from .context_builder import RAGContextBuilder
from .engine import RAGEngine
from .manager import DocumentSource, SourceManager

__all__ = [
    "RAGEngine",
    "RAGContextBuilder",
    "SourceManager",
    "DocumentSource",
]
