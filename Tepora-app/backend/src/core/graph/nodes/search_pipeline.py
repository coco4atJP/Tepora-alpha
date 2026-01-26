"""
Search pipeline nodes for V2 graph.

Provides nodes for:
- Search query generation (LLM)
- Web search execution (ToolManager)

This is used by TeporaGraph to implement Search Mode end-to-end.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from langchain_core.prompts import ChatPromptTemplate

from ..state import AgentState

if TYPE_CHECKING:
    from src.core.llm import LLMService
    from src.core.tools import ToolManager

logger = logging.getLogger(__name__)


class SearchPipelineNodes:
    """Nodes for search query generation and search execution."""

    def __init__(self, llm_service: LLMService, tool_manager: ToolManager):
        self.llm_service = llm_service
        self.tool_manager = tool_manager

    @staticmethod
    def _format_attachment_summaries(
        attachments: list[dict[str, Any]], *, max_items: int = 3, max_preview_chars: int = 400
    ) -> str:
        if not attachments:
            return "(none)"

        summaries: list[str] = []
        for attachment in attachments[:max_items]:
            name = attachment.get("name") or attachment.get("path") or "attachment"
            content = attachment.get("content", "")
            content_str = content if isinstance(content, str) else str(content)
            content_preview = content_str[:max_preview_chars]
            summaries.append(f"- {name}: {content_preview}")
        return "\n".join(summaries)

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

    async def generate_search_query_node(self, state: AgentState) -> dict[str, Any]:
        """
        Generate multiple search queries from user input.
        If skip_web_search is True, skip query generation entirely.
        """
        if state.get("skip_web_search"):
            logger.info("--- Node: Generate Search Query (SKIPPED - Web search disabled) ---")
            return {"search_queries": []}

        logger.info("--- Node: Generate Search Query (V2) ---")
        llm = await self.llm_service.get_client("character")

        base_request = state.get("search_query") or state["input"]
        attachments = state.get("search_attachments") or []
        attachments_text = self._format_attachment_summaries(attachments)

        prompt = ChatPromptTemplate.from_template(
            "Based on the user's request and the optional file attachments provided, propose two diverse and "
            "effective web search queries separated by a newline.\n"
            'User request: "{input}"\n'
            "Attachments summary:\n{attachments}"
        )

        chain = prompt | llm
        response_message = await chain.ainvoke(
            {
                "input": base_request,
                "attachments": attachments_text,
            }
        )

        raw_queries = str(getattr(response_message, "content", "")).strip().splitlines()
        queries = [q.strip("- ").strip() for q in raw_queries if q.strip()]

        if len(queries) > 2:
            queries = queries[:2]
        elif len(queries) < 2:
            fallback_query = str(state["input"]).strip()
            if fallback_query and fallback_query not in queries:
                queries.append(fallback_query)

        logger.info("Generated search queries: %s", queries)
        return {"search_queries": queries or ([base_request] if base_request else [])}

    async def execute_search_node(self, state: AgentState) -> dict[str, Any]:
        """Execute Google Custom Search tool and aggregate results."""
        logger.info("--- Node: Execute Search (V2) ---")

        if state.get("skip_web_search"):
            logger.info("Web search skipped by user request")
            return {"search_results": []}

        queries = state.get("search_queries") or []
        if not queries:
            fallback = state.get("search_query")
            if fallback:
                queries = [fallback]

        aggregated_results: list[dict[str, Any]] = []
        for query in queries:
            logger.info("Executing search for query: '%s'", query)

            raw_result = await self.tool_manager.aexecute_tool(
                "native_google_search", {"query": query}
            )

            if not isinstance(raw_result, str):
                logger.warning(
                    "Unexpected search result type for query '%s': %s",
                    query,
                    type(raw_result).__name__,
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

            tool_error = self._parse_tool_error(raw_result)
            if tool_error:
                logger.warning("Search tool returned error for query '%s': %s", query, tool_error)
                aggregated_results.append({"query": query, "results": [{"error": tool_error}]})
                continue

            try:
                parsed = json.loads(raw_result)
            except json.JSONDecodeError:
                logger.warning(
                    "Failed to parse search result for query '%s'. payload=%s",
                    query,
                    raw_result[:200],
                )
                aggregated_results.append(
                    {"query": query, "results": [{"error": "Failed to parse search results."}]}
                )
                continue

            if not isinstance(parsed, dict):
                logger.warning(
                    "Unexpected search payload for query '%s': %s", query, type(parsed).__name__
                )
                aggregated_results.append(
                    {"query": query, "results": [{"error": "Unexpected search response format."}]}
                )
                continue

            aggregated_results.append({"query": query, "results": parsed.get("results", [])})

        return {"search_results": aggregated_results}
