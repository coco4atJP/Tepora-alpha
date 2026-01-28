"""
Search Node - Search Result Summarization with RAG

Handles search mode responses with RAG context.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate

from ..constants import MemoryLimits
from ..state import AgentState

if TYPE_CHECKING:
    from src.core.context import ContextWindowManager
    from src.core.llm import LLMService
    from src.core.rag import RAGContextBuilder, RAGEngine

logger = logging.getLogger(__name__)


class SearchNode:
    """
    Search node for search result summarization.

    Uses RAG to enhance search results with detailed context.
    """

    def __init__(
        self,
        llm_service: LLMService,
        context_manager: ContextWindowManager,
        rag_engine: RAGEngine,
        context_builder: RAGContextBuilder,
    ):
        """
        Initialize search node.

        Args:
            llm_service: LLM service for model access
            context_manager: Context window manager
            rag_engine: RAG engine for chunk collection
            context_builder: RAG context builder
        """
        self.llm_service = llm_service
        self.context_manager = context_manager
        self.rag_engine = rag_engine
        self.context_builder = context_builder

    @staticmethod
    def _select_top_result_url(search_results: list[dict]) -> str | None:
        """Select top URL from search results."""
        for result_group in search_results:
            results = result_group.get("results")
            if isinstance(results, list) and results:
                url = results[0].get("url")
                if url:
                    return str(url)
        return None

    @staticmethod
    def _format_attachment_blocks(
        attachments: list[dict],
        *,
        max_preview_chars: int = 500,
        max_total_chars: int = 1500,
    ) -> str:
        """Format attachments for prompt."""
        if not attachments:
            return "No attachments were provided."

        blocks = []
        for att in attachments:
            name = att.get("name") or att.get("path") or "attachment"
            path = att.get("path") or "(path unavailable)"
            content = att.get("content", "")
            content_str = content if isinstance(content, str) else str(content)

            if len(content_str) > max_preview_chars:
                preview = (
                    content_str[:max_preview_chars] + "... (see RAG context for relevant excerpts)"
                )
            else:
                preview = content_str

            blocks.append(f"### {name}\nPath: {path}\nContent Preview:\n{preview}")

        result = "\n\n".join(blocks)
        if len(result) > max_total_chars:
            result = result[:max_total_chars] + "\n... (attachments truncated)"

        return result

    async def summarize_search_result_node(
        self,
        state: AgentState,
        *,
        persona: str = "",
        system_template: str = "",
        tool_executor: Any = None,
    ) -> dict[str, Any]:
        """
        Summarize search results with RAG.

        Args:
            state: Current agent state
            persona: Persona prompt
            system_template: System template for summarization
            tool_executor: Tool executor for web fetching

        Returns:
            Updated messages, chat_history, and generation_logprobs
        """
        logger.info("--- Node: Summarize Search Result (V2 with RAG) ---")

        skip_web_search = bool(state.get("skip_web_search", False))

        # Get models
        chat_client = await self.llm_service.get_client("character")
        embedding_client = await self.llm_service.get_embedding_client()

        # Get search results and attachments
        search_results = state.get("search_results", []) if not skip_web_search else []
        attachments = state.get("search_attachments") or []

        # Select top URL
        top_url = None
        if not skip_web_search and search_results:
            top_url = self._select_top_result_url(search_results)

        # Collect RAG chunks
        chunk_texts, chunk_sources = await self.rag_engine.collect_chunks(
            top_result_url=top_url,
            attachments=attachments,
            tool_executor=tool_executor,
            skip_web_fetch=skip_web_search,
        )

        # Build RAG context
        rag_context = self.context_builder.build_context(
            chunk_texts=chunk_texts,
            chunk_sources=chunk_sources,
            query=state["input"],
            embedding_model=embedding_client,
        )

        # Format attachments
        attachments_text = self._format_attachment_blocks(attachments)

        # Build prompt - include RAG context and search results for proper context
        system_prompt = (
            f"{persona}\n\n{system_template}\n\n"
            f"<relevant_memory>\n{{synthesized_memory}}\n</relevant_memory>\n\n"
            "When citing information, always include the source in [Source: URL] format."
        )

        prompt = ChatPromptTemplate.from_messages(
            [
                ("system", system_prompt),
                ("placeholder", "{chat_history}"),
                (
                    "human",
                    """Please summarize the search results for: {original_question}

<web_search_results>
{search_result}
</web_search_results>

<rag_context>
{rag_context}
</rag_context>

<attachments>
{attachments}
</attachments>

Provide a comprehensive answer with citations where applicable.""",
                ),
            ]
        )

        chain = prompt | chat_client

        # Limit chat history
        full_history = state.get("chat_history", [])
        limited_history, _ = await self.context_manager.build_local_context(
            full_history,
            max_tokens=MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS // 2,
        )

        # Limit synthesized memory
        synth_memory = str(state.get("synthesized_memory") or "No relevant memories.")
        if len(synth_memory) > 1000:
            synth_memory = synth_memory[:1000] + "\n... (memory truncated)"

        # Stream response
        full_response = ""
        logprobs = None

        search_snippets = (
            json.dumps(search_results, ensure_ascii=False, indent=2)
            if not skip_web_search
            else "(Web search disabled)"
        )

        async for chunk in chain.astream(
            {
                "chat_history": limited_history,
                "synthesized_memory": synth_memory,
                "original_question": state.get("search_query") or state["input"],
                "search_result": search_snippets,
                "rag_context": rag_context,
                "attachments": attachments_text,
            },
            config={"configurable": {"model_kwargs": {"logprobs": True}}},
        ):
            if hasattr(chunk, "content") and chunk.content:
                content = chunk.content
                full_response += (
                    content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                )
            if hasattr(chunk, "response_metadata") and chunk.response_metadata:
                chunk_logprobs = chunk.response_metadata.get("logprobs")
                if chunk_logprobs:
                    logprobs = chunk_logprobs

        return {
            "messages": [AIMessage(content=full_response)],
            "chat_history": state["chat_history"]
            + [
                HumanMessage(content=state["input"]),
                AIMessage(content=full_response),
            ],
            "generation_logprobs": logprobs,
        }

    async def stream_search_summary(
        self,
        state: AgentState,
        *,
        persona: str = "",
        system_template: str = "",
        tool_executor: Any = None,
    ) -> AsyncIterator[str]:
        """
        Stream search summary chunks.

        Yields:
            Response text chunks
        """
        skip_web_search = bool(state.get("skip_web_search", False))

        chat_client = await self.llm_service.get_client("character")
        embedding_client = await self.llm_service.get_embedding_client()

        search_results = state.get("search_results", []) if not skip_web_search else []
        attachments = state.get("search_attachments") or []

        top_url = None
        if not skip_web_search and search_results:
            top_url = self._select_top_result_url(search_results)

        chunk_texts, chunk_sources = await self.rag_engine.collect_chunks(
            top_result_url=top_url,
            attachments=attachments,
            tool_executor=tool_executor,
            skip_web_fetch=skip_web_search,
        )

        rag_context = self.context_builder.build_context(
            chunk_texts=chunk_texts,
            chunk_sources=chunk_sources,
            query=state["input"],
            embedding_model=embedding_client,
        )

        full_history = state.get("chat_history", [])
        limited_history, _ = await self.context_manager.build_local_context(
            full_history,
            max_tokens=MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS // 2,
        )

        # Format attachments
        attachments = state.get("search_attachments") or []
        attachments_text = self._format_attachment_blocks(attachments)

        # Build search snippets
        search_results = state.get("search_results", []) if not skip_web_search else []
        search_snippets = (
            json.dumps(search_results, ensure_ascii=False, indent=2)
            if not skip_web_search
            else "(Web search disabled)"
        )

        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    f"{persona}\n\n{system_template}\n\nWhen citing information, always include the source in [Source: URL] format.",
                ),
                ("placeholder", "{chat_history}"),
                (
                    "human",
                    """Summarize for: {original_question}

<web_search_results>
{search_result}
</web_search_results>

<rag_context>
{rag_context}
</rag_context>

<attachments>
{attachments}
</attachments>

Provide a comprehensive answer with citations where applicable.""",
                ),
            ]
        )

        chain = prompt | chat_client

        async for chunk in chain.astream(
            {
                "chat_history": limited_history,
                "original_question": state.get("search_query") or state["input"],
                "search_result": search_snippets,
                "rag_context": rag_context,
                "attachments": attachments_text,
            }
        ):
            if hasattr(chunk, "content") and chunk.content:
                content = chunk.content
                yield (
                    content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                )
