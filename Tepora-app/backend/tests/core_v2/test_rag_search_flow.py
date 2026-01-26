"""
Phase 3 RAG Search Flow Tests

Acceptance Criteria (Golden Flow):
1. Create a Session
2. Add dummy PDF source (mock text)
3. Switch to Search Mode
4. Ask a question about the PDF
5. Verify answer cites the source
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Path setup
_src_dir = Path(__file__).resolve().parents[2] / "src"
if str(_src_dir) not in sys.path:
    sys.path.insert(0, str(_src_dir))


# ============================================================
# RAG Module Tests
# ============================================================


class TestRAGEngine:
    """RAGEngine unit tests"""

    @pytest.mark.asyncio
    async def test_collect_chunks_from_attachments(self) -> None:
        """Test chunk collection from attachments"""
        from src.core.rag import RAGEngine

        engine = RAGEngine(chunk_size=100, chunk_overlap=10)

        attachments = [
            {
                "name": "test.txt",
                "path": "/path/to/test.txt",
                "content": "This is test content. " * 20,  # ~400 chars
            }
        ]

        chunk_texts, chunk_sources = await engine.collect_chunks(
            attachments=attachments,
            skip_web_fetch=True,
        )

        # Should have chunks
        assert len(chunk_texts) > 0
        assert len(chunk_sources) == len(chunk_texts)
        # All sources should reference the file
        assert all("file:" in src for src in chunk_sources)

    @pytest.mark.asyncio
    async def test_collect_chunks_with_web_fetch(self) -> None:
        """Test chunk collection with web fetch"""
        from src.core.rag import RAGEngine

        engine = RAGEngine()

        # Mock tool executor
        mock_executor = AsyncMock(return_value="Web page content. " * 50)

        chunk_texts, chunk_sources = await engine.collect_chunks(
            top_result_url="https://example.com",
            tool_executor=mock_executor,
        )

        # Should have called tool
        mock_executor.assert_called_once_with(
            "native_web_fetch",
            {"url": "https://example.com"},
        )

        # Should have chunks from web
        assert len(chunk_texts) > 0
        assert any("web:" in src for src in chunk_sources)


class TestRAGContextBuilder:
    """RAGContextBuilder unit tests"""

    def test_build_context_empty_chunks(self) -> None:
        """Test empty chunks returns no content message"""
        from src.core.rag import RAGContextBuilder

        builder = RAGContextBuilder()

        result = builder.build_context(
            chunk_texts=[],
            chunk_sources=[],
            query="test query",
            embedding_model=None,
        )

        assert "No relevant content" in result

    def test_build_context_with_mock_embeddings(self) -> None:
        """Test context building with mock embeddings"""
        from src.core.rag import RAGContextBuilder

        builder = RAGContextBuilder(top_k=2)

        # Mock embedding model
        mock_model = MagicMock()
        mock_model.embed_query.return_value = [0.1, 0.2, 0.3]
        mock_model.embed_documents.return_value = [
            [0.1, 0.2, 0.3],  # Similar to query
            [0.9, 0.8, 0.7],  # Different
            [0.15, 0.25, 0.35],  # Similar to query
        ]

        result = builder.build_context(
            chunk_texts=["chunk1", "chunk2", "chunk3"],
            chunk_sources=["src1", "src2", "src3"],
            query="test query",
            embedding_model=mock_model,
        )

        # Should include source citations
        assert "[Source:" in result
        # Should have content
        assert len(result) > 0


class TestSourceManager:
    """SourceManager unit tests"""

    def test_add_and_get_sources(self) -> None:
        """Test adding and retrieving sources"""
        from src.core.rag import DocumentSource, SourceManager

        manager = SourceManager()

        doc = DocumentSource(
            source_id="doc-1",
            session_id="session-123",
            name="test.pdf",
            source_type="file",
            content="Test content",
        )

        manager.add_document(doc)

        sources = manager.get_sources("session-123")
        assert len(sources) == 1
        assert sources[0].name == "test.pdf"

        # Different session should be empty
        other_sources = manager.get_sources("other-session")
        assert len(other_sources) == 0

    def test_clear_session(self) -> None:
        """Test clearing session sources"""
        from src.core.rag import DocumentSource, SourceManager

        manager = SourceManager()

        for i in range(3):
            manager.add_document(
                DocumentSource(
                    source_id=f"doc-{i}",
                    session_id="session-123",
                    name=f"file{i}.txt",
                    source_type="file",
                )
            )

        removed = manager.clear_session("session-123")
        assert removed == 3
        assert manager.source_count == 0


# ============================================================
# Context Window Tests
# ============================================================


class TestContextWindowManager:
    """ContextWindowManager unit tests"""

    @pytest.mark.asyncio
    async def test_build_local_context_within_limit(self) -> None:
        """Test context building within token limit"""
        from langchain_core.messages import HumanMessage

        from src.core.context import ContextWindowManager

        manager = ContextWindowManager(default_max_tokens=1000)

        messages = [HumanMessage(content=f"Message {i}") for i in range(5)]

        context, tokens = await manager.build_local_context(messages)

        # Should include all messages
        assert len(context) == 5

    @pytest.mark.asyncio
    async def test_build_local_context_trimming(self) -> None:
        """Test context trimming when exceeding limit"""
        from langchain_core.messages import HumanMessage

        from src.core.context import ContextWindowManager

        manager = ContextWindowManager(default_max_tokens=50)

        # Create messages that exceed limit
        messages = [HumanMessage(content="A" * 100) for _ in range(5)]

        context, tokens = await manager.build_local_context(messages)

        # Should trim to fit
        assert len(context) < 5
        assert len(context) >= 1  # At least one message


# ============================================================
# Graph Tests
# ============================================================


class TestTeporaGraph:
    """TeporaGraph unit tests"""

    def test_initialization(self) -> None:
        """Test graph initializes correctly"""
        from src.core.context import ContextWindowManager
        from src.core.graph import TeporaGraph
        from src.core.rag import RAGContextBuilder, RAGEngine

        with patch("src.core.llm.service.LlamaServerRunner"):
            from src.core.llm import LLMService

            llm_service = LLMService()
            context_manager = ContextWindowManager()
            rag_engine = RAGEngine()
            context_builder = RAGContextBuilder()

            graph = TeporaGraph(
                llm_service=llm_service,
                context_manager=context_manager,
                rag_engine=rag_engine,
                context_builder=context_builder,
            )

            assert graph is not None
            assert graph._chat_node is not None
            assert graph._search_node is not None


# ============================================================
# Agent Tests
# ============================================================


class TestBaseAgent:
    """BaseAgent unit tests"""

    @pytest.mark.asyncio
    async def test_skeleton_agent_execute(self) -> None:
        """Test skeleton agent execution"""
        from src.core.agent import SkeletonAgent

        agent = SkeletonAgent("test_agent", "Test description")

        state: dict[str, Any] = {
            "session_id": "session-1",
            "input": "Test input",
            "mode": "agent",
            "chat_history": [],
            "agent_scratchpad": [],
            "messages": [],
            "agent_outcome": None,
            "recalled_episodes": None,
            "synthesized_memory": None,
            "generation_logprobs": None,
            "search_queries": None,
            "search_results": None,
            "search_query": None,
            "search_attachments": None,
            "skip_web_search": None,
            "order": None,
            "task_input": None,
            "task_result": None,
        }

        result = await agent.execute(state)

        assert "messages" in result
        assert "agent_outcome" in result
        assert "Phase 3 skeleton" in result["agent_outcome"]


# ============================================================
# Golden Flow Test
# ============================================================


class TestRAGSearchGoldenFlow:
    """Phase 3 Acceptance Criteria: Golden Flow Test"""

    @pytest.mark.asyncio
    async def test_rag_search_flow(self) -> None:
        """
        Golden Flow: Create session, add source, search, verify citation.

        This is the Phase 3 acceptance criteria test.
        """
        from src.core.graph import create_initial_state
        from src.core.rag import DocumentSource, RAGContextBuilder, RAGEngine, SourceManager

        # 1. Create session resources
        session_id = "test-session-123"
        source_manager = SourceManager()

        # 2. Add dummy PDF source
        doc = DocumentSource(
            source_id="pdf-1",
            session_id=session_id,
            name="test_document.pdf",
            source_type="file",
            content=(
                "This document describes the Tepora AI assistant. "
                "Tepora is a local-first AI agent that runs on consumer hardware. "
                "It uses a modular architecture with RAG capabilities. "
                "The system supports multiple modes: chat, search, and agent. "
                "Key features include episodic memory and tool execution."
            ),
        )
        source_manager.add_document(doc)

        # Verify source was added
        sources = source_manager.get_sources(session_id)
        assert len(sources) == 1
        assert sources[0].name == "test_document.pdf"

        # 3. Create state for search mode
        state = create_initial_state(
            session_id=session_id,
            user_input="What are the key features of Tepora?",
            mode="search",
        )

        assert state["session_id"] == session_id
        assert state["mode"] == "search"

        # 4. Collect RAG chunks from the source
        rag_engine = RAGEngine()
        attachments = [{"name": doc.name, "content": doc.content, "path": doc.name}]

        chunk_texts, chunk_sources = await rag_engine.collect_chunks(
            attachments=attachments,
            skip_web_fetch=True,
        )

        assert len(chunk_texts) > 0, "Should have chunks from document"
        assert any("test_document.pdf" in src for src in chunk_sources)

        # 5. Build RAG context with mock embeddings
        context_builder = RAGContextBuilder(top_k=3)

        mock_embedding = MagicMock()
        # Return consistent embeddings for semantic similarity
        mock_embedding.embed_query.return_value = [0.5] * 64
        mock_embedding.embed_documents.return_value = [
            [0.5 + i * 0.01] * 64 for i in range(len(chunk_texts))
        ]

        rag_context = context_builder.build_context(
            chunk_texts=chunk_texts,
            chunk_sources=chunk_sources,
            query=state["input"],
            embedding_model=mock_embedding,
        )

        # 6. Verify answer cites the source
        assert "[Source:" in rag_context, "RAG context should include source citations"
        assert "file:" in rag_context, "Should cite file source"

        # Verify context contains relevant content
        assert any(
            keyword in rag_context.lower() for keyword in ["tepora", "modular", "memory", "agent"]
        ), "Context should include relevant keywords from document"
