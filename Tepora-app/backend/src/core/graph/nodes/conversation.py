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
from typing import TYPE_CHECKING

import numpy as np
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate
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
        persona_override, persona_key = config.get_persona_prompt_for_profile(
            default_key=config.ACTIVE_PERSONA,
            default_prompt=config.PERSONA_PROMPTS[config.ACTIVE_PERSONA],
        )
        if persona_override:
            persona = persona_override
        elif persona_key and persona_key in config.PERSONA_PROMPTS:
            persona = config.PERSONA_PROMPTS[persona_key]
        else:
            persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]

        system_prompt = config.get_prompt_for_profile(
            "direct_answer",
            base=config.resolve_system_prompt("direct_answer"),
        )
        
        # Build hierarchical context (EM-LLM & Attention Sink compliant)
        full_history = state.get("chat_history", [])
        
        # Get retrieved memory context
        retrieved_memory_str = state.get('synthesized_memory', 'No relevant memories found.')
        
        # Build unified system message with all context
        # 1. Attention Sink (fixed prefix)
        # 2. System/Persona Context
        # 3. Retrieved Memory Context (long-term)
        system_content_parts = [
            ATTENTION_SINK_PREFIX,
            "",  # blank line
            "<instructions>",
            "Your persona and instructions for this conversation are defined as follows:",
            "",
            f"<persona_definition>\n{persona}\n</persona_definition>",
            "",
            f"<system_prompt>\n{system_prompt}\n</system_prompt>",
            "</instructions>",
            "",
            "--- Relevant Context from Past Conversations ---",
            retrieved_memory_str,
        ]
        
        # 4. Local Context (short-term) construction
        max_local_tokens = MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS
        local_context = []
        current_local_tokens = 0
        
        for i in range(len(full_history) - 1, -1, -1):
            msg = full_history[i]
            msg_tokens = await self.llm_manager.count_tokens_for_messages([msg])
            if current_local_tokens + msg_tokens > max_local_tokens and local_context:
                break
            local_context.insert(0, msg)  # Maintain order
            current_local_tokens += msg_tokens
        
        # 5. Add omission notice if needed
        if len(local_context) != len(full_history):
            # Long history: add omission notice to system message
            system_content_parts.extend([
                "",
                "... (omitted earlier conversation for brevity; rely on the provided long-term memories above) ...",
                "--- Returning to recent conversation context ---"
            ])
            logger.info("Context: Using hierarchical structure (Attention Sink > System/Persona > Retrieved > Local).")
            logger.debug(f"  - Local Context: {len(local_context)} messages (~{current_local_tokens} tokens)")
            logger.debug(f"  - Omitted: {len(full_history) - len(local_context)} messages")
        else:
            # Short history: use full history as local context
            logger.info(
                f"Context: History is short. Using full history as local context "
                f"({len(local_context)} messages)."
            )
        
        # Create single unified system message
        unified_system_message = SystemMessage(content="\n".join(system_content_parts))
        
        # Combine unified system message with local context
        context_messages = [unified_system_message] + local_context
        
        context_history = [clone_message_with_timestamp(msg) for msg in context_messages]
        
        # Build prompt and invoke LLM
        prompt = ChatPromptTemplate.from_messages([
            ("placeholder", "{context_history}"),
            ("human", "<user_input>{input}</user_input>")
        ])
        
        chain = prompt | llm
        
        # Request logprobs for surprise calculation
        response_message = await chain.ainvoke(
            {
                "context_history": context_history,
                "input": state["input"],
            },
            config={
                "configurable": {
                    "model_kwargs": {
                        "logprobs": True,
                        "cache_prompt": True
                    }
                }
            }
        )
        
        # Extract logprobs from response
        logprobs = response_message.response_metadata.get("logprobs")
        
        return {
            "chat_history": state["chat_history"] + [
                HumanMessage(content=state["input"]),
                AIMessage(content=response_message.content)
            ],
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
        if attachments:
            attachment_summaries = []
            for attachment in attachments[:3]:
                name = attachment.get("name") or attachment.get("path") or "attachment"
                content_preview = attachment.get("content", "")[:400]
                attachment_summaries.append(f"- {name}: {content_preview}")
            attachments_text = "\n".join(attachment_summaries)
        else:
            attachments_text = "(none)"

        prompt = ChatPromptTemplate.from_template(
            "Based on the user's request and the optional file attachments provided, propose two diverse and "
            "effective web search queries separated by a newline.\n"
            "User request: \"{input}\"\n"
            "Attachments summary:\n{attachments}"
        )
        chain = prompt | llm
        response_message = await chain.ainvoke({"input": base_request, "attachments": attachments_text})
        
        raw_queries = response_message.content.strip().splitlines()
        queries = [q.strip('- ').strip() for q in raw_queries if q.strip()]
        
        if len(queries) > 2:
            queries = queries[:2]
        elif len(queries) < 2:
            # Fallback: supplement with user input if needed
            fallback_query = state["input"].strip()
            if fallback_query and fallback_query not in queries:
                queries.append(fallback_query)
        
        logger.info(f"Generated search queries: {queries}")
        return {"search_queries": queries or ([base_request] if base_request else [])}
    
    def execute_search_node(self, state: AgentState) -> dict:
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
            raw_result = self.tool_manager.execute_tool("native_google_search", {"query": query})
            
            if not isinstance(raw_result, str):
                logger.warning("Unexpected search result type for query '%s': %s", query, type(raw_result))
                aggregated_results.append({
                    "query": query,
                    "results": [{"error": "Received unexpected result format from search tool."}]
                })
                continue
            
            if raw_result.strip().startswith("Error:"):
                logger.warning("Search tool returned error for query '%s': %s", query, raw_result)
                aggregated_results.append({"query": query, "results": [{"error": raw_result}]})
                continue
            
            try:
                parsed = json.loads(raw_result)
                aggregated_results.append({"query": query, "results": parsed.get("results", [])})
            except json.JSONDecodeError:
                logger.warning("Failed to parse search result for query '%s'. payload=%s", query, raw_result[:200])
                aggregated_results.append({
                    "query": query,
                    "results": [{"error": "Failed to parse search results."}]
                })
        
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
        skip_web_search = state.get("skip_web_search", False)
        
        # Load Gemma-3n and embedding model
        llm = await self.llm_manager.get_character_model()
        embedding_llm = await self.llm_manager.get_embedding_model()
        
        # Prepare search result snippets (empty if web search disabled)
        search_results_list = state.get("search_results", []) if not skip_web_search else []
        search_snippets = json.dumps(search_results_list, ensure_ascii=False, indent=2) if not skip_web_search else "(Web search disabled)"

        attachments = state.get("search_attachments") or []

        # Identify most promising URL (only if web search is enabled)
        top_result_url = None
        if not skip_web_search and search_results_list and isinstance(search_results_list, list):
            for result_group in search_results_list:
                if (result_group.get("results") and
                    isinstance(result_group["results"], list) and
                    len(result_group["results"]) > 0):
                    top_result_url = result_group["results"][0].get("link")
                    if top_result_url:
                        break
        
        # RAG pipeline
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=RAGConfig.CHUNK_SIZE,
            chunk_overlap=RAGConfig.CHUNK_OVERLAP
        )
        chunk_texts: list[str] = []
        chunk_sources: list[str] = []

        if top_result_url:
            logger.info("--- Fetching most promising URL: %s ---", top_result_url)
            content = await self.tool_manager.aexecute_tool("native_web_fetch", {"url": top_result_url})
            
            if isinstance(content, str) and content and not content.startswith("Error:"):
                logger.info("--- Fetched content (%d chars). Starting RAG pipeline. ---", len(content))
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
            if not attachment_content:
                continue
            source_label = attachment.get("path") or attachment.get("name") or "attachment"
            file_chunks = text_splitter.split_text(attachment_content)
            logger.info("Attachment '%s' yielded %d chunk(s) for RAG.", source_label, len(file_chunks))
            for chunk in file_chunks:
                chunk_texts.append(chunk)
                chunk_sources.append(f"file:{source_label}")

        rag_context = "No relevant content found from web results or attachments."
        if chunk_texts:
            if not all(hasattr(embedding_llm, attr) for attr in ("embed_query", "embed_documents")):
                logger.error("Embedding model does not expose embed_query/embed_documents. Skipping RAG.")
                rag_context = "Embedding model unavailable for RAG."
            else:
                query_embedding = np.array(embedding_llm.embed_query(state["input"]))
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
                else:
                    chunk_embeddings = np.array(chunk_embeddings_list)
                    chunk_texts = embedded_chunk_texts
                    chunk_sources = embedded_chunk_sources

                    similarities = cosine_similarity(query_embedding, chunk_embeddings)[0]
                    top_k = min(RAGConfig.TOP_K_CHUNKS, len(chunk_texts))
                    top_indices = similarities.argsort()[-top_k:][::-1]
                    selected_contexts = [
                        f"[Source: {chunk_sources[i]}]\n{chunk_texts[i]}"
                        for i in top_indices
                    ]
                    rag_context = "\n\n---\n\n".join(selected_contexts)
                    
                    # Limit RAG context size to prevent context overflow
                    MAX_RAG_CONTEXT_CHARS = 3000
                    if len(rag_context) > MAX_RAG_CONTEXT_CHARS:
                        rag_context = rag_context[:MAX_RAG_CONTEXT_CHARS] + "\n... (truncated for context limit)"
                        logger.info("RAG context truncated to %d chars", MAX_RAG_CONTEXT_CHARS)
                    
                    logger.info("Extracted %d most relevant chunks from combined sources.", len(selected_contexts))
        
        # Build summarization prompt
        persona_override, persona_key = config.get_persona_prompt_for_profile(
            default_key=config.ACTIVE_PERSONA,
            default_prompt=config.PERSONA_PROMPTS[config.ACTIVE_PERSONA],
        )
        if persona_override:
            persona = persona_override
        elif persona_key and persona_key in config.PERSONA_PROMPTS:
            persona = config.PERSONA_PROMPTS[persona_key]
        else:
            persona = config.PERSONA_PROMPTS[config.ACTIVE_PERSONA]

        attachments = state.get("search_attachments") or []
        if attachments:
            attachment_blocks = []
            MAX_ATTACHMENT_PREVIEW_CHARS = 500  # Limit per attachment
            for attachment in attachments:
                name = attachment.get("name") or attachment.get("path") or "attachment"
                path = attachment.get("path") or "(path unavailable)"
                content = attachment.get("content", "")
                # Truncate content preview
                if len(content) > MAX_ATTACHMENT_PREVIEW_CHARS:
                    preview = content[:MAX_ATTACHMENT_PREVIEW_CHARS] + "... (content truncated, see RAG context for relevant excerpts)"
                else:
                    preview = content
                attachment_blocks.append(
                    f"### {name}\nPath: {path}\nContent Preview:\n{preview}"
                )
            attachments_text = "\n\n".join(attachment_blocks)
            # Total attachments text limit
            MAX_TOTAL_ATTACHMENTS_CHARS = 1500
            if len(attachments_text) > MAX_TOTAL_ATTACHMENTS_CHARS:
                attachments_text = attachments_text[:MAX_TOTAL_ATTACHMENTS_CHARS] + "\n... (attachments truncated)"
        else:
            attachments_text = "No attachments were provided."

        # Use different system template based on whether web search is enabled
        if skip_web_search:
            # Attachment-only mode: Focus on file attachments as the primary source
            system_template = config.get_prompt_for_profile(
                "attachment_summary",
                base="""You are a document analysis expert. Your task is to answer the user's question based on the provided file attachments.
Base your answer *exclusively* on the information given in the file attachments and retrieved context below.

User's original question: {original_question}

=== Retrieved Context from Attachments ===
{rag_context}

=== File Attachments ===
{attachments}

Instructions:
1. Use the "Retrieved Context" and "File Attachments" as your primary and only source of truth.
2. Do NOT make assumptions or use external knowledge.
3. If the answer is not found in the attachments, clearly state that.
4. Synthesize the information into a coherent and helpful response.""",
            )
        else:
            # Web search mode: Use web results and attachments
            system_template = config.get_prompt_for_profile(
                "search_summary",
                base="""You are a search summarization expert. Your task is to synthesize the provided search result snippets and the most relevant text chunks from a web page to answer the user's original question.
Base your answer *primarily* on the information given in the context below.

User's original question: {original_question}

=== Search Result Snippets ===
{search_snippets}

=== Retrieved Context from Web Page ===
{rag_context}

=== File Attachments ===
{attachments}

Instructions:
1. Use the "Retrieved Context" as the primary source of truth.
2. Use "Search Result Snippets" to supplement information if needed.
3. If the answer is not found in the context, clearly state that.
4. Synthesize the information into a coherent and helpful response.""",
            )

        prompt = ChatPromptTemplate.from_messages([
            (
                "system",
                f"{persona}\n\n{system_template}\n\n--- Relevant Context from Past Conversations ---\n{{synthesized_memory}}",
            ),
            ("placeholder", "{chat_history}"),
            ("human", "Please summarize the search results for my request: {original_question}")
        ])

        chain = prompt | llm
        
        # Limit chat history to prevent context size overflow
        # Reserve tokens for system prompt, RAG context, and response generation
        max_history_tokens = MemoryLimits.MAX_LOCAL_CONTEXT_TOKENS // 2  # Conservative limit
        full_history = state.get("chat_history", [])
        limited_history = []
        current_tokens = 0
        
        for i in range(len(full_history) - 1, -1, -1):
            msg = full_history[i]
            msg_tokens = await self.llm_manager.count_tokens_for_messages([msg])
            if current_tokens + msg_tokens > max_history_tokens and limited_history:
                break
            limited_history.insert(0, msg)
            current_tokens += msg_tokens
        
        if len(limited_history) != len(full_history):
            logger.info(
                "Truncated chat history for summarization: %d -> %d messages (~%d tokens)",
                len(full_history), len(limited_history), current_tokens
            )

        # Limit synthesized memory to prevent context overflow
        synthesized_memory = state.get('synthesized_memory', 'No relevant memories found.')
        MAX_SYNTHESIZED_MEMORY_CHARS = 1000
        if len(synthesized_memory) > MAX_SYNTHESIZED_MEMORY_CHARS:
            synthesized_memory = synthesized_memory[:MAX_SYNTHESIZED_MEMORY_CHARS] + "\n... (memory truncated)"

        response_message = await chain.ainvoke(
            {
                "chat_history": limited_history,
                "synthesized_memory": synthesized_memory,
                "original_question": state.get("search_query") or state["input"],
                "search_snippets": search_snippets,
                "rag_context": rag_context,
                "attachments": attachments_text,
            },
            config={
                "configurable": {
                    "model_kwargs": {
                        "logprobs": True,
                        "cache_prompt": True
                    }
                }
            }
        )
        
        # Extract logprobs
        logprobs = response_message.response_metadata.get("logprobs")
        
        return {
            "messages": [AIMessage(content=response_message.content)],
            "chat_history": state["chat_history"] + [
                HumanMessage(content=state["input"]),
                AIMessage(content=response_message.content)
            ],
            "generation_logprobs": logprobs,
        }
