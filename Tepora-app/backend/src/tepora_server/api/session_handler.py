"""
WebSocket Session Handler

Encapsulates message processing logic for a single WebSocket connection.
This improves testability and separation of concerns.
"""

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from src.core.config import STREAM_EVENT_CHAT_MODEL, settings
from src.core.graph.constants import GraphNodes
from src.tepora_server.state import AppState

# Tools that require confirmation before execution.
# Design: Blocking approval - backend waits for user response via WebSocket.
# DANGEROUS_TOOLS is now imported from src.core.graph.constants

logger = logging.getLogger("tepora.server.ws.session")


class SessionHandler:
    """
    Handles a single WebSocket session.

    Encapsulates the processing logic for incoming messages,
    activity tracking, and streaming responses.
    """

    NODE_DESCRIPTIONS: dict[str, str] = {
        GraphNodes.GENERATE_ORDER: "Analyzing user request...",
        GraphNodes.GENERATE_SEARCH_QUERY: "Identifying necessary tools...",
        GraphNodes.EXECUTE_SEARCH: "Executing search query...",
        GraphNodes.SUMMARIZE_SEARCH_RESULT: "Synthesizing search results...",
        GraphNodes.AGENT_REASONING: "Reasoning & deciding next steps...",
        GraphNodes.TOOL_NODE: "Executing external tools...",
        GraphNodes.SYNTHESIZE_FINAL_RESPONSE: "Synthesizing final response...",
        GraphNodes.UPDATE_SCRATCHPAD: "Updating memory...",
        GraphNodes.THINKING_NODE: "Thinking deeply...",
    }

    AGENT_NAMES: dict[str, str] = {
        GraphNodes.GENERATE_ORDER: "Planner",
        GraphNodes.GENERATE_SEARCH_QUERY: "Search Analyst",
        GraphNodes.EXECUTE_SEARCH: "Search Tool",
        GraphNodes.SUMMARIZE_SEARCH_RESULT: "Researcher",
        GraphNodes.AGENT_REASONING: "Executor",
        GraphNodes.TOOL_NODE: "Tool Handler",
        GraphNodes.SYNTHESIZE_FINAL_RESPONSE: "Synthesizer",
        GraphNodes.UPDATE_SCRATCHPAD: "Memory Manager",
        GraphNodes.THINKING_NODE: "Thinker",
    }

    def __init__(self, websocket: WebSocket, app_state: AppState):
        """
        Initialize the session handler.

        Args:
            websocket: The WebSocket connection to handle.
            app_state: Application state containing the core app.
        """
        self.websocket = websocket
        self.app_state = app_state
        self.current_task: asyncio.Task | None = None
        self.client_host = websocket.client.host if websocket.client else "unknown"

        # Track current node for streaming context
        self._current_node_id: str | None = None
        self._current_agent_name: str | None = None

        # Pending tool approval requests (request_id -> Future[bool])
        self._pending_approvals: dict[str, asyncio.Future] = {}

        # Phase 5: MCP tool approval tracking (per-session)
        self._approved_mcp_tools: set[str] = set()  # Tools approved in this session

    async def on_disconnect(self) -> None:
        """Handle cleanup on WebSocket disconnection."""
        logger.info("Session disconnected: %s", self.client_host)
        await self.handle_stop()

        # Cleanup pending approvals
        count = 0
        for req_id, future in self._pending_approvals.items():
            if not future.done():
                future.cancel()
                count += 1
        self._pending_approvals.clear()
        if count > 0:
            logger.info("Cancelled %d pending tool approvals", count)

    async def send_json(self, data: dict) -> bool:
        """
        Send JSON data to the client.

        Returns:
            True if sent successfully, False if disconnected.
        """
        try:
            await self.websocket.send_json(data)
            return True
        except (RuntimeError, WebSocketDisconnect):
            logger.debug("Failed to send to %s: client disconnected", self.client_host)
            return False

    async def handle_stop(self) -> None:
        """Cancel the current processing task."""
        if self.current_task and not self.current_task.done():
            logger.info("Stop command received from %s, cancelling task.", self.client_host)
            self.current_task.cancel()

    async def handle_get_stats(self) -> None:
        """Send memory statistics to the client."""
        stats = self.app_state.active_core.get_memory_stats()
        await self.send_json({"type": "stats", "data": stats})

    def _cleanup_stale_approvals(self) -> None:
        """Remove completed or cancelled futures to prevent memory leaks."""
        stale_ids = [req_id for req_id, future in self._pending_approvals.items() if future.done()]
        for req_id in stale_ids:
            self._pending_approvals.pop(req_id, None)

    async def request_tool_approval(self, tool_name: str, tool_args: dict[str, Any]) -> bool:
        """
        Request user approval for a dangerous tool execution.

        Sends a confirmation request to the frontend and waits for response.
        This is called from the tool executor node via approval callback.

        Args:
            tool_name: Name of the tool requesting approval
            tool_args: Arguments to be passed to the tool

        Returns:
            True if approved, False if denied or cancelled
        """
        # Cleanup any stale approvals to prevent memory leaks
        self._cleanup_stale_approvals()

        request_id = str(uuid.uuid4())

        # Create a Future to wait for the response
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._pending_approvals[request_id] = future

        # Send confirmation request to frontend
        logger.info("Requesting approval for tool '%s' (request_id: %s)", tool_name, request_id)
        sent = await self.send_json(
            {
                "type": "tool_confirmation_request",
                "data": {
                    "requestId": request_id,
                    "toolName": tool_name,
                    "toolArgs": tool_args
                    if isinstance(tool_args, dict)
                    else {"input": str(tool_args)},
                    "description": f"Tool '{tool_name}' requires your approval to execute.",
                },
            }
        )
        if not sent:
            self._pending_approvals.pop(request_id, None)
            return False

        try:
            # Wait for user response (with timeout from config)
            timeout = settings.app.tool_approval_timeout
            approved = await asyncio.wait_for(future, timeout=float(timeout))
            return approved
        except TimeoutError:
            logger.warning("Tool approval request %s timed out", request_id)
            return False
        except asyncio.CancelledError:
            logger.info("Tool approval request %s cancelled", request_id)
            return False
        finally:
            # Cleanup
            self._pending_approvals.pop(request_id, None)

    def handle_tool_confirmation(self, request_id: str, approved: bool) -> None:
        """
        Handle tool confirmation response from frontend.

        Args:
            request_id: The ID of the confirmation request
            approved: Whether the user approved the tool execution
        """
        future = self._pending_approvals.get(request_id)
        if future and not future.done():
            logger.info(
                "Tool confirmation received: request_id=%s, approved=%s", request_id, approved
            )
            future.set_result(approved)
        else:
            logger.warning("No pending approval found for request_id: %s", request_id)

    # --- Phase 5: MCP Tool Handling ---

    def is_mcp_tool(self, tool_name: str) -> bool:
        """
        Check if a tool is an MCP tool based on naming convention.

        MCP tools are prefixed with their server name (e.g., "filesystem_read_file").
        """
        # MCP tools follow the pattern: {server_name}_{tool_name}
        # Check if tool name contains underscore and isn't a known native tool
        if "_" not in tool_name:
            return False

        # Get MCP hub to check registered servers
        if hasattr(self.app_state, "mcp_hub") and self.app_state.mcp_hub:
            for server_name in self.app_state.mcp_hub._tools:
                if tool_name.startswith(f"{server_name}_"):
                    return True

        return False

    def is_mcp_tool_approved_in_session(self, tool_name: str) -> bool:
        """Check if an MCP tool has been approved in this session."""
        return tool_name in self._approved_mcp_tools

    def approve_mcp_tool_for_session(self, tool_name: str) -> None:
        """Mark an MCP tool as approved for this session."""
        self._approved_mcp_tools.add(tool_name)
        logger.info("MCP tool '%s' approved for this session", tool_name)

    async def request_mcp_tool_approval(self, tool_name: str, tool_args: dict[str, Any]) -> bool:
        """
        Request approval for MCP tool on first use in session.

        Returns True if:
        - Tool already approved in this session
        - User approves the tool

        Returns False if user denies.
        """
        # Check if already approved in this session
        if self.is_mcp_tool_approved_in_session(tool_name):
            return True

        # Request approval
        approved = await self.request_tool_approval(tool_name, tool_args)

        if approved:
            self.approve_mcp_tool_for_session(tool_name)

        return approved

    async def _send_activity_update(
        self, node_name: str, status: str, message_override: str | None = None
    ) -> None:
        """Send an activity update to the client."""
        if node_name not in self.NODE_DESCRIPTIONS and not message_override:
            return

        desc = message_override or self.NODE_DESCRIPTIONS.get(node_name, "Processing...")
        await self.send_json(
            {"type": "activity", "data": {"id": node_name, "status": status, "message": desc}}
        )

    async def process_message(
        self,
        user_input: str,
        mode: str,
        attachments: list[dict[str, Any]],
        skip_web_search: bool,
        session_id: str = "default",
        thinking_mode: bool | None = None,
    ) -> None:
        """
        Process a user message.

        Args:
            user_input: The user's message text.
            mode: The processing mode (direct, search, agent).
            attachments: List of attachments.
            skip_web_search: Whether to skip web search.
            session_id: The session ID for chat history.
        """
        try:
            if not user_input and not attachments:
                return

            if not self.app_state.active_core.initialized:
                logger.warning("Core not initialized; rejecting message from %s", self.client_host)
                await self.send_json(
                    {"type": "error", "message": "Server not initialized. Please retry shortly."}
                )
                return

            await self.send_json({"type": "status", "message": "Processing..."})
            logger.info(
                "Processing input from %s in mode '%s' session '%s': %s...",
                self.client_host,
                mode,
                session_id,
                user_input[:50],
            )

            self._current_node_id = None
            self._current_agent_name = None

            # Call Core.process_user_request with approval callback
            async for event in self.app_state.active_core.process_user_request(
                user_input,
                mode=mode,
                attachments=attachments,
                skip_web_search=skip_web_search,
                session_id=session_id,
                approval_callback=self.request_tool_approval,
                thinking_mode=thinking_mode,
            ):
                await self._handle_stream_event(event, mode)

            # Send Memory Stats
            stats = self.app_state.active_core.get_memory_stats()
            await self.send_json({"type": "stats", "data": stats})
            await self.send_json({"type": "done"})

        except asyncio.CancelledError:
            logger.info("Message processing cancelled for %s", self.client_host)
            await self.send_json({"type": "status", "message": "Cancelled"})
            raise
        except Exception as e:
            logger.error("Error processing message: %s", e, exc_info=True)
            await self.send_json({"type": "error", "message": "Processing error occurred"})

    async def send_history(self, session_id: str) -> None:
        """Send chat history for the given session to the client."""
        try:
            history_manager = self.app_state.active_core.history_manager
            if history_manager is None:
                logger.warning(
                    "History manager not initialized; cannot load history for %s", session_id
                )
                await self.send_json(
                    {"type": "error", "message": "History manager not initialized"}
                )
                return

            messages = history_manager.get_history(session_id=session_id, limit=100)

            # Format messages for frontend
            formatted_messages = []
            for msg in messages:
                role = "user"
                if msg.type == "ai":
                    role = "assistant"
                elif msg.type == "system":
                    role = "system"

                formatted_messages.append(
                    {
                        "id": str(getattr(msg, "id", ""))
                        or str(uuid.uuid4()),  # Fallback if id missing
                        "role": role,
                        "content": msg.content,
                        "timestamp": msg.additional_kwargs.get("timestamp")
                        or datetime.now().isoformat(),
                        "mode": msg.additional_kwargs.get("mode", "direct"),
                    }
                )

            # Sort by timestamp/ID if necessary, but get_history returns ordered
            # Send history message
            await self.send_json({"type": "history", "messages": formatted_messages})
            logger.info(
                "Sent %d history messages for session %s to %s",
                len(formatted_messages),
                session_id,
                self.client_host,
            )

        except Exception as e:
            logger.error("Failed to send history: %s", e, exc_info=True)
            await self.send_json({"type": "error", "message": "Failed to load history"})

    async def _handle_stream_event(self, event: dict[str, Any], mode: str) -> None:
        """Handle a single stream event from the core."""
        kind = event["event"]

        if kind == STREAM_EVENT_CHAT_MODEL:
            chunk = event["data"]["chunk"]
            if chunk.content:
                success = await self.send_json(
                    {
                        "type": "chunk",
                        "message": chunk.content,
                        "mode": mode,
                        "nodeId": self._current_node_id,
                        "agentName": self._current_agent_name,
                    }
                )
                if not success:
                    raise WebSocketDisconnect()

        elif kind == "on_chain_start":
            node_name = event.get("name")
            if node_name in self.NODE_DESCRIPTIONS:
                self._current_node_id = node_name
                self._current_agent_name = self.AGENT_NAMES.get(node_name, "System")
                await self._send_activity_update(node_name, "processing")

        elif kind == "on_chain_end":
            node_name = event.get("name")
            if node_name in self.NODE_DESCRIPTIONS:
                await self._send_activity_update(node_name, "done")

            # Handle search results specifically
            if node_name == GraphNodes.EXECUTE_SEARCH:
                await self._handle_search_results(event)

        # Note: on_tool_start is no longer handled here.
        # Dangerous tool approval is now managed via approval_callback injection.

    async def _handle_search_results(self, event: dict[str, Any]) -> None:
        """Handle search results from the EXECUTE_SEARCH node."""
        output = event["data"].get("output")
        if not output or "search_results" not in output:
            return

        flattened_results = []
        for group in output["search_results"]:
            if "results" in group and isinstance(group["results"], list):
                flattened_results.extend(group["results"])

        if flattened_results:
            logger.info("Sending %d search results to frontend", len(flattened_results))
            await self.send_json({"type": "search_results", "data": flattened_results})
