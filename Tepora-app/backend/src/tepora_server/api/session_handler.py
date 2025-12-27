"""
WebSocket Session Handler

Encapsulates message processing logic for a single WebSocket connection.
This improves testability and separation of concerns.
"""
import asyncio
import logging
import uuid
from typing import Optional, Dict, Any, List, Set

from fastapi import WebSocket, WebSocketDisconnect

from src.core.config import STREAM_EVENT_CHAT_MODEL
from src.core.graph.constants import GraphNodes, DANGEROUS_TOOLS
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
    
    NODE_DESCRIPTIONS: Dict[str, str] = {
        GraphNodes.GENERATE_ORDER: "Analyzing user request...",
        GraphNodes.GENERATE_SEARCH_QUERY: "Identifying necessary tools...",
        GraphNodes.EXECUTE_SEARCH: "Executing search query...",
        GraphNodes.SUMMARIZE_SEARCH_RESULT: "Synthesizing search results...",
        GraphNodes.AGENT_REASONING: "Reasoning & deciding next steps...",
        GraphNodes.TOOL_NODE: "Executing external tools...",
        GraphNodes.SYNTHESIZE_FINAL_RESPONSE: "Synthesizing final response...",
        GraphNodes.UPDATE_SCRATCHPAD: "Updating memory...",
    }
    
    AGENT_NAMES: Dict[str, str] = {
        GraphNodes.GENERATE_ORDER: "Planner",
        GraphNodes.GENERATE_SEARCH_QUERY: "Search Analyst",
        GraphNodes.EXECUTE_SEARCH: "Search Tool",
        GraphNodes.SUMMARIZE_SEARCH_RESULT: "Researcher",
        GraphNodes.AGENT_REASONING: "Executor",
        GraphNodes.TOOL_NODE: "Tool Handler",
        GraphNodes.SYNTHESIZE_FINAL_RESPONSE: "Synthesizer",
        GraphNodes.UPDATE_SCRATCHPAD: "Memory Manager",
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
        self.current_task: Optional[asyncio.Task] = None
        self.client_host = websocket.client.host if websocket.client else "unknown"
        
        # Track current node for streaming context
        self._current_node_id: Optional[str] = None
        self._current_agent_name: Optional[str] = None
        
        # Pending tool approval requests (request_id -> Future[bool])
        self._pending_approvals: Dict[str, asyncio.Future] = {}
    
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
            logger.debug(f"Failed to send to {self.client_host}: client disconnected")
            return False
    
    async def handle_stop(self) -> None:
        """Cancel the current processing task."""
        if self.current_task and not self.current_task.done():
            logger.info(f"Stop command received from {self.client_host}, cancelling task.")
            self.current_task.cancel()
    
    async def handle_get_stats(self) -> None:
        """Send memory statistics to the client."""
        stats = self.app_state.core.get_memory_stats()
        await self.send_json({"type": "stats", "data": stats})
    
    async def request_tool_approval(self, tool_name: str, tool_args: Dict[str, Any]) -> bool:
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
        request_id = str(uuid.uuid4())
        
        # Create a Future to wait for the response
        loop = asyncio.get_event_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._pending_approvals[request_id] = future
        
        # Send confirmation request to frontend
        logger.info(f"Requesting approval for tool '{tool_name}' (request_id: {request_id})")
        await self.send_json({
            "type": "tool_confirmation_request",
            "data": {
                "requestId": request_id,
                "toolName": tool_name,
                "toolArgs": tool_args if isinstance(tool_args, dict) else {"input": str(tool_args)},
                "description": f"Tool '{tool_name}' requires your approval to execute."
            }
        })
        
        try:
            # Wait for user response (with timeout)
            approved = await asyncio.wait_for(future, timeout=300.0)  # 5 minute timeout
            return approved
        except asyncio.TimeoutError:
            logger.warning(f"Tool approval request {request_id} timed out")
            return False
        except asyncio.CancelledError:
            logger.info(f"Tool approval request {request_id} cancelled")
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
            logger.info(f"Tool confirmation received: request_id={request_id}, approved={approved}")
            future.set_result(approved)
        else:
            logger.warning(f"No pending approval found for request_id: {request_id}")
    
    async def _send_activity_update(
        self, 
        node_name: str, 
        status: str, 
        message_override: Optional[str] = None
    ) -> None:
        """Send an activity update to the client."""
        if node_name not in self.NODE_DESCRIPTIONS and not message_override:
            return
        
        desc = message_override or self.NODE_DESCRIPTIONS.get(node_name, "Processing...")
        await self.send_json({
            "type": "activity",
            "data": {
                "id": node_name,
                "status": status,
                "message": desc
            }
        })
    
    async def process_message(
        self, 
        user_input: str, 
        mode: str, 
        attachments: List[Dict[str, Any]], 
        skip_web_search: bool
    ) -> None:
        """
        Process a user message.
        
        Args:
            user_input: The user's message text.
            mode: The processing mode (direct, search, agent).
            attachments: List of attachments.
            skip_web_search: Whether to skip web search.
        """
        try:
            if not user_input and not attachments:
                return

            await self.send_json({"type": "status", "message": "Processing..."})
            logger.info(f"Processing input from {self.client_host} in mode '{mode}': {user_input[:50]}...")

            self._current_node_id = None
            self._current_agent_name = None

            # Call Core.process_user_request with approval callback
            async for event in self.app_state.core.process_user_request(
                user_input, 
                mode=mode, 
                attachments=attachments, 
                skip_web_search=skip_web_search,
                approval_callback=self.request_tool_approval
            ):
                await self._handle_stream_event(event, mode)

            # Send Memory Stats
            stats = self.app_state.core.get_memory_stats()
            await self.send_json({"type": "stats", "data": stats})
            await self.send_json({"type": "done"})
            
        except asyncio.CancelledError:
            logger.info(f"Message processing cancelled for {self.client_host}")
            await self.send_json({"type": "status", "message": "Cancelled"})
            raise
        except Exception as e:
            logger.error(f"Error processing message: {e}", exc_info=True)
            await self.send_json({"type": "error", "message": "Processing error occurred"})
    
    async def _handle_stream_event(self, event: Dict[str, Any], mode: str) -> None:
        """Handle a single stream event from the core."""
        kind = event["event"]
        
        if kind == STREAM_EVENT_CHAT_MODEL:
            chunk = event["data"]["chunk"]
            if chunk.content:
                success = await self.send_json({
                    "type": "chunk",
                    "message": chunk.content,
                    "mode": mode,
                    "nodeId": self._current_node_id,
                    "agentName": self._current_agent_name
                })
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
    
    async def _handle_search_results(self, event: Dict[str, Any]) -> None:
        """Handle search results from the EXECUTE_SEARCH node."""
        output = event["data"].get("output")
        if not output or "search_results" not in output:
            return
        
        flattened_results = []
        for group in output["search_results"]:
            if "results" in group and isinstance(group["results"], list):
                flattened_results.extend(group["results"])
        
        if flattened_results:
            logger.info(f"Sending {len(flattened_results)} search results to frontend")
            await self.send_json({
                "type": "search_results",
                "data": flattened_results
            })
