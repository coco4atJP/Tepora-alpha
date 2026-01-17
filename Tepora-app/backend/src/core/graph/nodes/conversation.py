"""
Conversation-related graph nodes.

This module provides nodes for:
- Direct answer generation
- Search query generation
- Search execution
- Search result summarization
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

import numpy as np
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_text_splitters import RecursiveCharacterTextSplitter
from sklearn.metrics.pairwise import cosine_similarity

from ... import config
from ..constants import ATTENTION_SINK_PREFIX, MemoryLimits, RAGConfig
from ..utils import clone_message_with_timestamp

if TYPE_CHECKING:
    from ...llm_manager import LLMManager
    from ...state import AgentState
    from ...tool_manager import ToolManager

logger = logging.getLogger(__name__)


class ConversationNodes:
    """Conversation-related graph node implementations."""

    def __init__(self, llm_manager: LLMManager, tool_manager: ToolManager):
        """
        Initialize conversation nodes.

        Args:
            llm_manager: LLM manager for model access
            tool_manager: Tool manager for tool execution
        """
        self.llm_manager = llm_manager
        self.tool_manager = tool_manager

    @staticmethod
    def _format_attachment_summaries(
        attachments: list[dict], *, max_items: int, max_preview_chars: int
    ) -> str:
        if not attachments:
            return "(none)"

        summaries = []
        for attachment in attachments[:max_items]:
            name = attachment.get("name") or attachment.get("path") or "attachment"
            content = attachment.get("content", "")
            content_str = content if isinstance(content, str) else str(content)
            content_preview = content_str[:max_preview_chars]
            summaries.append(f"- {name}: {content_preview}")
        return "\n".join(summaries)

    @staticmethod
    def _select_top_result_url(search_results: list[dict]) -> str | None:
        for result_group in search_results:
            results = result_group.get("results")
            if isinstance(results, list) and results:
                url = results[0].get("url")
                if url:
                    return str(url)
        return None

    @staticmethod
    def _parse_tool_error(payload: str) -> str | None:
        payload_stripped = payload.lstrip()
        if not payload_stripped.startswith("{"):
            return None
        try:
            data = json.loads(payload_stripped)
        except json.JSONDecodeError:
            return None
        if isinstance(data, dict) and data.get("error"):
            return data.get("message") or data.get("error_code") or "Tool error"
        return None

    @staticmethod
    def _format_attachment_blocks(
        attachments: list[dict],
        *,
        max_preview_chars: int,
        max_total_chars: int,
    ) -> str:
        if not attachments:
            return "No attachments were provided."

        attachment_blocks = []
        for attachment in attachments:
            name = attachment.get("name") or attachment.get("path") or "attachment"
            path = attachment.get("path") or "(path unavailable)"
            content = attachment.get("content", "")
            content_str = content if isinstance(content, str) else str(content)
            if len(content_str) > max_preview_chars:
                preview = (
                    content_str[:max_preview_chars]
                    + "... (content truncated, see RAG context for relevant excerpts)"
                )
            else:
                preview = content_str
            attachment_blocks.append(f"### {name}\nPath: {path}\nContent Preview:\n{preview}")

        attachments_text = "\n\n".join(attachment_blocks)
        if len(attachments_text) > max_total_chars:
            attachments_text = attachments_text[:max_total_chars] + "\n... (attachments truncated)"
        return attachments_text

    async def _build_local_context(self, full_history: list, max_tokens: int) -> tuple[list, int]:
        local_context: list[Any] = []
        current_tokens = 0
        for i in range(len(full_history) - 1, -1, -1):
            msg = full_history[i]
            msg_tokens = await self.llm_manager.count_tokens_for_messages([msg])
            if current_tokens + msg_tokens > max_tokens and local_context:
                break
            local_context.insert(0, msg)
            current_tokens += msg_tokens
        return local_context, current_tokens

    async def _collect_rag_chunks(
        self,
        *,
        top_result_url: str | None,
        attachments: list[dict],
        text_splitter: RecursiveCharacterTextSplitter,
        skip_web_search: bool,
    ) -> tuple[list[str], list[str]]:
        chunk_texts: list[str] = []
        chunk_sources: list[str] = []

        if top_result_url:
            logger.info("--- Fetching most promising URL: %s ---", top_result_url)
            content = await self.tool_manager.aexecute_tool(
                "native_web_fetch", {"url": top_result_url}
            )

            if isinstance(content, str) and content and not content.startswith("Error:"):
                tool_error = self._parse_tool_error(content)
                if tool_error:
                    logger.warning("Web fetch failed for URL '%s': %s", top_result_url, tool_error)
                    content = ""

            if isinstance(content, str) and content and not content.startswith("Error:"):
                logger.info(
                    "--- Fetched content (%d chars). Starting RAG pipeline. ---", len(content)
                )
                chunks = text_splitter.split_text(content)
                logger.info("Split content into %d chunks from web page.", len(chunks))
                for chunk in chunks:
                    chunk_texts.append(chunk)
                    chunk_sources.append(f"web:{top_result_url}")
            else:
                logger.warning("Web fetch failed for URL '%s': %s", top_result_url, content)
        elif skip_web_search:
            logger.info("Web search disabled - using attachments only for RAG")

        for attachment in attachments:
            attachment_content = attachment.get("content", "")
            if not isinstance(attachment_content, str):
                attachment_content = str(attachment_content)
            if not attachment_content:
                continue
            source_label = attachment.get("path") or attachment.get("name") or "attachment"
            file_chunks = text_splitter.split_text(attachment_content)
            logger.info(
                "Attachment '%s' yielded %d chunk(s) for RAG.", source_label, len(file_chunks)
            )
            for chunk in file_chunks:
                chunk_texts.append(chunk)
                chunk_sources.append(f"file:{source_label}")

        return chunk_texts, chunk_sources

    @staticmethod
    def _build_rag_context(
        *,
        chunk_texts: list[str],
        chunk_sources: list[str],
        query: str,
        embedding_llm: Any,
    ) -> str:
        rag_context = "No relevant content found from web results or attachments."
        if not chunk_texts:
            return rag_context

        if not all(hasattr(embedding_llm, attr) for attr in ("embed_query", "embed_documents")):
            logger.error(
                "Embedding model does not expose embed_query/embed_documents. Skipping RAG."
            )
            return "Embedding model unavailable for RAG."

        query_embedding = np.array(embedding_llm.embed_query(query))
        if query_embedding.ndim == 1:
            query_embedding = query_embedding.reshape(1, -1)

        batch_size = getattr(RAGConfig, "EMBEDDING_BATCH_SIZE", len(chunk_texts) or 1)
        embedded_chunk_texts: list[str] = []
        embedded_chunk_sources: list[str] = []
        chunk_embeddings_list: list[list[float]] = []

        for batch_start in range(0, len(chunk_texts), batch_size):
            batch_end = batch_start + batch_size
            batch_texts = chunk_texts[batch_start:batch_end]
            batch_sources = chunk_sources[batch_start:batch_end]

            try:
                batch_embeddings = embedding_llm.embed_documents(batch_texts)
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "Failed to embed chunk batch %d-%d: %s",
                    batch_start,
                    batch_end - 1,
                    exc,
                    exc_info=True,
                )
                continue

            if not batch_embeddings:
                logger.warning(
                    "Embedding batch %d-%d returned no vectors. Skipping that batch.",
                    batch_start,
                    batch_end - 1,
                )
                continue

            chunk_embeddings_list.extend(batch_embeddings)
            embedded_chunk_texts.extend(batch_texts)
            embedded_chunk_sources.extend(batch_sources)

        if not chunk_embeddings_list:
            logger.warning("Embedding model returned empty embeddings. Skipping similarity search.")
            return rag_context

        chunk_embeddings = np.array(chunk_embeddings_list)
        chunk_texts = embedded_chunk_texts
        chunk_sources = embedded_chunk_sources

        similarities = cosine_similarity(query_embedding, chunk_embeddings)[0]
        top_k = min(RAGConfig.TOP_K_CHUNKS, len(chunk_texts))
        top_indices = similarities.argsort()[-top_k:][::-1]
        selected_contexts = [f"[Source: {chunk_sources[i]}]\n{chunk_texts[i]}" for i in top_indices]
        rag_context = "\n\n---\n\n".join(selected_contexts)

        max_rag_context_chars = 3000
        if len(rag_context) > max_rag_context_chars:
            rag_context = (
                rag_context[:max_rag_context_chars] + "\n... (truncated for context limit)"
            )
            logger.info("RAG context truncated to %d chars", max_rag_context_chars)

        logger.info(
            "Extracted %d most relevant chunks from combined sources.", len(selected_contexts)
        )
        return rag_context

    async def direct_answer_node(self, state: AgentState) -> dict:
        """
        Generate a simple one-turn response with system prompt.

        Implements hierarchical context structure:
        1. Attention Sink (fixed prefix)
        2. System/Persona Context
        3. Retrieved Memory (long-term)
        4. Local Context (short-term)

        Args:
            state: Current agent state

        Returns:
            Updated chat_history and generation_logprobs
        """
        logger.info("--- Node: Direct Answer (Streaming, EM-LLM Context) ---")

        # Load Gemma-3N
        llm = await self.llm_manager.get_character_model()

        # Get persona and system prompt (apply agent profile overrides)
        persona, _ = config.get_persona_prompt_for_profile()
        if not persona:
            # Should be handled by get_persona_prompt_for_profile raising error, but just in case
            raise ValueError("Could not retrieve active persona prompt.")

        system_prompt = config.get_prompt_for_profile(
            "direct_answer",
            base=config.resolve_system_prompt("direct_answer"),
        )

        # Build hierarchical context (EM-LLM & Attention Sink compliant)
        full_history = state.get("chat_history", [])

        # Get retrieved memory context (long-term memory summary)
        retrieved_memory_str: str = str(
            state.get("synthesized_memory") or "No relevant memories found."
        )

        # Build unified system message with all context
        # 1. Attention Sink (fixed prefix)
        # 2. System/Persona Context
        # 3. Retrieved Memory Context (long-term)
        system_content_parts = [
            ATTENTION_SINK_PREFIX,
            "",  # blank line
            f"{persona}",
            "",
            f"{system_prompt}",
            "",
            "<retrieved_memory>",
            retrieved_memory_str,
            "</retrieved_memory>",
        ]

        # 4. Local Context (short-term) construction
        max_local_tokens = MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS
        local_context, current_local_tokens = await self._build_local_context(
            full_history, max_local_tokens
        )

        # 5. Add omission notice if needed
        if len(local_context) != len(full_history):
            # Long history: add omission notice to system message
            system_content_parts.extend(
                [
                    "",
                    "... (omitted earlier conversation for brevity; rely on the provided long-term memories above) ...",
                    "--- Returning to recent conversation context ---",
                ]
            )
            logger.info(
                "Context: Using hierarchical structure (Attention Sink > System/Persona > Retrieved > Local)."
            )
            logger.debug(
                "  - Local Context: %d messages (~%d tokens)",
                len(local_context),
                current_local_tokens,
            )
            logger.debug("  - Omitted: %d messages", len(full_history) - len(local_context))
        else:
            # Short history: use full history as local context
            logger.info(
                "Context: History is short. Using full history as local context (%d messages).",
                len(local_context),
            )

        # Create single unified system message
        unified_system_message = SystemMessage(content="\n".join(system_content_parts))

        # Combine unified system message with local context
        context_messages = [unified_system_message] + local_context

        context_history = [clone_message_with_timestamp(msg) for msg in context_messages]

        # Build prompt and invoke LLM
        prompt = ChatPromptTemplate.from_messages(
            [("placeholder", "{context_history}"), ("human", "<user_input>{input}</user_input>")]
        )

        chain = prompt | llm

        # Request logprobs for surprise calculation
        response_message = await chain.ainvoke(
            {
                "context_history": context_history,
                "input": state["input"],
            },
            config={"configurable": {"model_kwargs": {"logprobs": True, "cache_prompt": True}}},
        )

        # Extract logprobs from response
        logprobs = response_message.response_metadata.get("logprobs")

        return {
            "chat_history": state["chat_history"]
            + [HumanMessage(content=state["input"]), AIMessage(content=response_message.content)],
            "generation_logprobs": logprobs,
        }

    async def generate_search_query_node(self, state: AgentState) -> dict:
        """
        Generate multiple search queries from user input.
        If skip_web_search is True, skip query generation entirely.

        Args:
            state: Current agent state

        Returns:
            Dictionary with search_queries list
        """
        # Skip query generation if web search is disabled
        if state.get("skip_web_search"):
            logger.info("--- Node: Generate Search Query (SKIPPED - Web search disabled) ---")
            return {"search_queries": []}

        logger.info("--- Node: Generate Search Query (using Gemma 3N) ---")
        llm = await self.llm_manager.get_character_model()

        base_request = state.get("search_query") or state["input"]
        attachments = state.get("search_attachments") or []
        attachments_text = self._format_attachment_summaries(
            attachments, max_items=3, max_preview_chars=400
        )

        prompt = ChatPromptTemplate.from_template(
            "Based on the user's request and the optional file attachments provided, propose two diverse and "
            "effective web search queries separated by a newline.\n"
            'User request: "{input}"\n'
            "Attachments summary:\n{attachments}"
        )
        chain = prompt | llm
        response_message = await chain.ainvoke(
            {"input": base_request, "attachments": attachments_text}
        )

        raw_queries = response_message.content.strip().splitlines()
        queries = [q.strip("- ").strip() for q in raw_queries if q.strip()]

        if len(queries) > 2:
            queries = queries[:2]
        elif len(queries) < 2:
            # Fallback: supplement with user input if needed
            fallback_query = state["input"].strip()
            if fallback_query and fallback_query not in queries:
                queries.append(fallback_query)

        logger.info("Generated search queries: %s", queries)
        return {"search_queries": queries or ([base_request] if base_request else [])}

    async def execute_search_node(self, state: AgentState) -> dict:
        """
        Execute Google Custom Search API tool and aggregate results.

        Args:
            state: Current agent state

        Returns:
            Dictionary with search_results
        """
        logger.info("--- Node: Execute Search ---")

        # Check if web search should be skipped
        if state.get("skip_web_search"):
            logger.info("Web search skipped by user request")
            return {"search_results": []}

        queries = state.get("search_queries") or []
        if not queries:
            fallback = state.get("search_query")
            if fallback:
                queries = [fallback]
        aggregated_results = []

        for query in queries:
            logger.info("Executing search for query: '%s'", query)
            # Use async execution to avoid blocking the event loop
            raw_result = await self.tool_manager.aexecute_tool(
                "native_google_search", {"query": query}
            )

            if not isinstance(raw_result, str):
                logger.warning(
                    "Unexpected search result type for query '%s': %s", query, type(raw_result)
                )
                aggregated_results.append(
                    {
                        "query": query,
                        "results": [
                            {"error": "Received unexpected result format from search tool."}
                        ],
                    }
                )
                continue

            if raw_result.strip().startswith("Error:"):
                logger.warning("Search tool returned error for query '%s': %s", query, raw_result)
                aggregated_results.append({"query": query, "results": [{"error": raw_result}]})
                continue

            try:
                parsed = json.loads(raw_result)
                if isinstance(parsed, dict) and parsed.get("error"):
                    error_message = parsed.get("message") or "Search tool error."
                    logger.warning(
                        "Search tool returned error for query '%s': %s",
                        query,
                        error_message,
                    )
                    aggregated_results.append(
                        {"query": query, "results": [{"error": error_message}]}
                    )
                    continue
                if not isinstance(parsed, dict):
                    logger.warning(
                        "Unexpected search payload for query '%s': %s", query, type(parsed)
                    )
                    aggregated_results.append(
                        {
                            "query": query,
                            "results": [{"error": "Unexpected search response format."}],
                        }
                    )
                    continue
                aggregated_results.append({"query": query, "results": parsed.get("results", [])})
            except json.JSONDecodeError:
                logger.warning(
                    "Failed to parse search result for query '%s'. payload=%s",
                    query,
                    raw_result[:200],
                )
                aggregated_results.append(
                    {"query": query, "results": [{"error": "Failed to parse search results."}]}
                )

        return {"search_results": aggregated_results}

    async def summarize_search_result_node(self, state: AgentState) -> dict:
        """
        Convert search results into a user-friendly summary using RAG.

        Args:
            state: Current agent state

        Returns:
            Updated messages, chat_history, and generation_logprobs
        """
        logger.info("--- Node: Summarize Search Result (Streaming with RAG) ---")

        # Check if web search/fetch should be skipped
        skip_web_search: bool = bool(state.get("skip_web_search", False))

        # Load Gemma-3n and embedding model
        llm = await self.llm_manager.get_character_model()
        embedding_llm = await self.llm_manager.get_embedding_model()

        # Prepare search result snippets (empty if web search disabled)
        search_results_list = state.get("search_results", []) if not skip_web_search else []
        search_snippets = (
            json.dumps(search_results_list, ensure_ascii=False, indent=2)
            if not skip_web_search
            else "(Web search disabled)"
        )

        attachments = state.get("search_attachments") or []

        # Identify most promising URL (only if web search is enabled)
        top_result_url = None
        if not skip_web_search and search_results_list and isinstance(search_results_list, list):
            top_result_url = self._select_top_result_url(search_results_list)

        # RAG pipeline
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=RAGConfig.CHUNK_SIZE, chunk_overlap=RAGConfig.CHUNK_OVERLAP
        )
        chunk_texts, chunk_sources = await self._collect_rag_chunks(
            top_result_url=top_result_url,
            attachments=attachments,
            text_splitter=text_splitter,
            skip_web_search=skip_web_search,
        )
        rag_context = self._build_rag_context(
            chunk_texts=chunk_texts,
            chunk_sources=chunk_sources,
            query=state["input"],
            embedding_llm=embedding_llm,
        )

        # Build summarization prompt
        persona, _ = config.get_persona_prompt_for_profile()
        if not persona:
            raise ValueError("Could not retrieve active persona prompt.")

        attachments_text = self._format_attachment_blocks(
            attachments,
            max_preview_chars=500,
            max_total_chars=1500,
        )

        # Use different system template based on whether web search is enabled
        if skip_web_search:
            # Attachment-only mode: Focus on file attachments as the primary source
            system_template = config.get_prompt_for_profile(
                "attachment_summary",
                base="""<system_instructions>
You are a document analysis expert.

<task>
Answer user question based EXCLUSIVELY on attachments.
</task>

<input_context>
Question: {original_question}

<retrieved_context>
{rag_context}
</retrieved_context>

<attachments>
{attachments}
</attachments>
</input_context>

<constraints>
- Primary Source: Attachments & Retrieved Context ONLY.
- No Assumptions: Do not use external knowledge.
- Honesty: State clearly if answer is not found.
</constraints>
</system_instructions>""",
            )
        else:
            # Web search mode: Use web results and attachments
            system_template = config.get_prompt_for_profile(
                "search_summary",
                base=config.resolve_system_prompt("search_summary"),
            )

        system_prompt = (
            f"{persona}\n\n{system_template}\n\n<relevant_context>\n"
            "{synthesized_memory}\n</relevant_context>"
        )
        prompt = ChatPromptTemplate.from_messages(
            [
                ("system", system_prompt),
                ("placeholder", "{chat_history}"),
                (
                    "human",
                    "Please summarize the search results for my request: {original_question}",
                ),
            ]
        )

        chain = prompt | llm

        # Limit chat history to prevent context size overflow
        # Reserve tokens for system prompt, RAG context, and response generation
        max_history_tokens = MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS // 2  # Conservative limit
        full_history = state.get("chat_history", [])
        limited_history, current_tokens = await self._build_local_context(
            full_history, max_history_tokens
        )

        if len(limited_history) != len(full_history):
            logger.info(
                "Truncated chat history for summarization: %d -> %d messages (~%d tokens)",
                len(full_history),
                len(limited_history),
                current_tokens,
            )

        # Limit synthesized memory to prevent context overflow
        synthesized_memory: str = str(
            state.get("synthesized_memory") or "No relevant memories found."
        )
        max_synthesized_memory_chars = 1000  # noqa: N806
        if len(synthesized_memory) > max_synthesized_memory_chars:
            synthesized_memory = (
                synthesized_memory[:max_synthesized_memory_chars] + "\n... (memory truncated)"
            )

        response_message = await chain.ainvoke(
            {
                "chat_history": limited_history,
                "persona": persona,
                "system_template": system_template,
                "synthesized_memory": synthesized_memory,
                "original_question": state.get("search_query") or state["input"],
                "search_result": search_snippets,
                "rag_context": rag_context,
                "attachments": attachments_text,
            },
            config={"configurable": {"model_kwargs": {"logprobs": True, "cache_prompt": True}}},
        )

        # Extract logprobs
        logprobs = response_message.response_metadata.get("logprobs")

        return {
            "messages": [AIMessage(content=response_message.content)],
            "chat_history": state["chat_history"]
            + [HumanMessage(content=state["input"]), AIMessage(content=response_message.content)],
            "generation_logprobs": logprobs,
        }
