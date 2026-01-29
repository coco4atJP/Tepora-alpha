/**
 * WebSocket Store - Zustand store for WebSocket connection management
 *
 * This store manages:
 * - WebSocket connection state
 * - Reconnection logic
 * - Tool confirmation flow
 * - Message sending
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { Attachment, ChatMode, ToolConfirmationRequest } from "../types";
import { getWsBase } from "../utils/api";
import { getSessionToken, refreshSessionToken } from "../utils/sessionToken";
import { backendReady, isDesktop } from "../utils/sidecar";
import { useChatStore } from "./chatStore";
import { useSessionStore } from "./sessionStore";

// ============================================================================
// Types
// ============================================================================

interface WebSocketState {
	// Connection state
	isConnected: boolean;
	socket: WebSocket | null;
	reconnectAttempts: number;

	// Tool confirmation
	pendingToolConfirmation: ToolConfirmationRequest | null;
	approvedTools: Set<string>;
}

interface WebSocketActions {
	// Connection management
	connect: () => Promise<void>;
	disconnect: () => void;

	// Message sending
	sendMessage: (
		content: string,
		mode: ChatMode,
		attachments?: Attachment[],
		skipWebSearch?: boolean,
		thinkingMode?: boolean,
	) => void;
	sendRaw: (data: object) => void;

	// Control commands
	stopGeneration: () => void;
	requestStats: () => void;
	setSession: (sessionId: string) => void;

	// Tool confirmation
	setPendingToolConfirmation: (request: ToolConfirmationRequest | null) => void;
	handleToolConfirmation: (
		requestId: string,
		approved: boolean,
		remember: boolean,
	) => void;
	isToolApproved: (toolName: string) => boolean;
	approveToolForSession: (toolName: string) => void;
}

export type WebSocketStore = WebSocketState & WebSocketActions;

// ============================================================================
// Constants
// ============================================================================

const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;

// ============================================================================
// Helpers
// ============================================================================

const getWsUrl = (token: string | null = null): string => {
	let baseUrl: string;
	if (isDesktop()) {
		baseUrl = `${getWsBase()}/ws`;
	} else {
		baseUrl = import.meta.env.VITE_WS_URL || `${getWsBase()}/ws`;
	}

	if (token) {
		const separator = baseUrl.includes("?") ? "&" : "?";
		return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
	}
	return baseUrl;
};

const calculateBackoff = (attempt: number): number => {
	const delay = Math.min(
		BASE_RECONNECT_DELAY * 2 ** attempt,
		MAX_RECONNECT_DELAY,
	);
	const jitter = delay * 0.1 * (Math.random() * 2 - 1);
	return delay + jitter;
};

// Agent name mapping for activity messages
const AGENT_MAPPING: Record<string, string> = {
	generate_order: "Planner",
	generate_search_query: "Search Analyst",
	execute_search: "Search Tool",
	summarize_search_result: "Researcher",
	agent_reasoning: "Professional Agent",
	tool_node: "Tool Handler",
	synthesize_final_response: "Synthesizer",
	update_scratchpad: "Memory Manager",
	thinking: "Deep Thinker",
};

// ============================================================================
// Initial State
// ============================================================================

const initialState: WebSocketState = {
	isConnected: false,
	socket: null,
	reconnectAttempts: 0,
	pendingToolConfirmation: null,
	approvedTools: new Set(),
};

// ============================================================================
// Store
// ============================================================================

export const useWebSocketStore = create<WebSocketStore>()(
	devtools(
		(set, get) => {
			// Track mounting state
			let isMounted = true;
			let shouldReconnect = true;
			let isConnecting = false;
			let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
			let tokenCache: string | null = null;

			// Helper to handle incoming messages
			const handleMessage = (event: MessageEvent) => {
				try {
					const data = JSON.parse(event.data);
					const chatStore = useChatStore.getState();
					const sessionStore = useSessionStore.getState();

					switch (data.type) {
						case "chunk":
							chatStore.handleStreamChunk(data.message || "", {
								mode: data.mode,
								agentName: data.agentName,
								nodeId: data.nodeId,
							});
							break;

						case "done":
							chatStore.finalizeStream();
							chatStore.setIsProcessing(false);
							// Trigger session refresh event
							window.dispatchEvent(new CustomEvent("session-refresh"));
							break;

						case "stopped":
							chatStore.finalizeStream();
							chatStore.setIsProcessing(false);
							break;

						case "error":
							chatStore.setError(data.message || "Unknown error");
							chatStore.addMessage({
								id: Date.now().toString(),
								role: "system",
								content: `Error: ${data.message || "Unknown error"}`,
								timestamp: new Date(),
							});
							chatStore.setIsProcessing(false);
							break;

						case "stats":
							if (data.data) {
								chatStore.setMemoryStats(data.data);
							}
							break;

						case "search_results":
							if (data.data && Array.isArray(data.data)) {
								chatStore.setSearchResults(data.data);
							}
							break;

						case "activity":
							if (data.data) {
								const rawEntry = data.data;
								const agentName = AGENT_MAPPING[rawEntry.id] || rawEntry.id;
								const statusMap: Record<
									string,
									"pending" | "processing" | "completed" | "error"
								> = {
									done: "completed",
									processing: "processing",
									pending: "pending",
									error: "error",
								};
								chatStore.updateActivity({
									status: statusMap[rawEntry.status] || "processing",
									agent_name: agentName,
									details: rawEntry.message,
									step: 0, // Will be set by the store
								});
							}
							break;

						case "tool_confirmation_request":
							if (data.data) {
								const request = data.data as ToolConfirmationRequest;
								const state = get();
								if (state.approvedTools.has(request.toolName)) {
									// Auto-approve if already approved in session
									state.sendRaw({
										type: "tool_confirmation_response",
										requestId: request.requestId,
										approved: true,
									});
								} else {
									set(
										{ pendingToolConfirmation: request },
										false,
										"setToolConfirmation",
									);
								}
							}
							break;

						case "history":
							if (data.messages && Array.isArray(data.messages)) {
								const parsedMessages = data.messages.map(
									(msg: { timestamp: string | number | Date }) => ({
										...msg,
										timestamp: new Date(msg.timestamp),
									}),
								);
								chatStore.setMessages(parsedMessages);
							}
							sessionStore.setIsLoadingHistory(false);
							break;

						case "session_changed":
							if (import.meta.env.DEV) {
								console.log(`Session switched to ${data.sessionId}`);
							}
							break;

						case "download_progress":
							if (data.data) {
								window.dispatchEvent(
									new CustomEvent("download-progress", { detail: data.data }),
								);
							}
							break;
					}
				} catch (error) {
					console.error("WebSocket message parse error:", error);
					useChatStore.getState().setError("Failed to parse server message");
				}
			};

			return {
				...initialState,

				// ------------------------------------------------------------------
				// Connection Management
				// ------------------------------------------------------------------

				connect: async () => {
					// Allow reconnect after a previous disconnect/unmount
					isMounted = true;
					shouldReconnect = true;

					// Idempotent: don't create multiple sockets
					const existing = get().socket;
					if (
						existing &&
						(existing.readyState === WebSocket.OPEN ||
							existing.readyState === WebSocket.CONNECTING)
					) {
						return;
					}

					// Coalesce concurrent connect() calls
					if (isConnecting) return;
					isConnecting = true;

					if (reconnectTimeout) {
						clearTimeout(reconnectTimeout);
						reconnectTimeout = null;
					}

					try {
						// Wait for backend in desktop mode
						if (isDesktop()) {
							await backendReady;
						}

						// Get token if needed
						if (!tokenCache) {
							tokenCache = await getSessionToken();
						}

						const wsUrl = getWsUrl(tokenCache);
						const ws = new WebSocket(wsUrl);

						ws.onopen = () => {
							if (!isMounted) {
								ws.close();
								return;
							}
							set(
								{ isConnected: true, socket: ws, reconnectAttempts: 0 },
								false,
								"connected",
							);
							useChatStore.getState().setIsProcessing(false);
							useChatStore.getState().setError(null);

							// Load initial history
							const sessionId = useSessionStore.getState().currentSessionId;
							get().setSession(sessionId);
						};

						ws.onmessage = handleMessage;

						ws.onerror = (error) => {
							if (!isMounted) return;
							console.error("WebSocket error:", error);
						};

						ws.onclose = (event) => {
							if (!isMounted) return;
							set({ isConnected: false, socket: null }, false, "disconnected");
							useChatStore.getState().setIsProcessing(false);

							// Handle auth failure
							if (event.code === 4001) {
								tokenCache = null;
								refreshSessionToken().catch(console.warn);
							}

							// Reconnect with backoff
							const attempts = get().reconnectAttempts;
							const delay = calculateBackoff(attempts);
							console.log(
								`WebSocket disconnected. Reconnecting in ${Math.round(delay)}ms`,
							);

							reconnectTimeout = setTimeout(() => {
								if (isMounted) {
									set(
										{ reconnectAttempts: attempts + 1 },
										false,
										"reconnectAttempt",
									);
									get().connect();
								}
							}, delay);
						};

						set({ socket: ws }, false, "socketCreated");
					} catch (error) {
						if (!isMounted) return;
						console.error("WebSocket connection failed:", error);
						set({ isConnected: false }, false, "connectionFailed");

						// Retry on failure (unless explicitly disconnected)
						if (!shouldReconnect) return;
						const attempts = get().reconnectAttempts;
						const delay = calculateBackoff(attempts);
						reconnectTimeout = setTimeout(() => {
							if (isMounted) {
								set(
									{ reconnectAttempts: attempts + 1 },
									false,
									"reconnectAttempt",
								);
								get().connect();
							}
						}, delay);
					} finally {
						isConnecting = false;
					}
				},

				disconnect: () => {
					shouldReconnect = false;
					isMounted = false;
					if (reconnectTimeout) {
						clearTimeout(reconnectTimeout);
						reconnectTimeout = null;
					}
					const { socket } = get();
					if (socket) {
						socket.onopen = null;
						socket.onmessage = null;
						socket.onerror = null;
						socket.onclose = null;
						socket.close();
					}
					set({ socket: null, isConnected: false }, false, "disconnect");
				},

				// ------------------------------------------------------------------
				// Message Sending
				// ------------------------------------------------------------------

				sendMessage: (
					content,
					mode,
					attachments = [],
					skipWebSearch = false,
					thinkingMode = false,
				) => {
					const { socket, isConnected } = get();
					const chatStore = useChatStore.getState();
					const sessionStore = useSessionStore.getState();

					if (!isConnected || !socket) {
						chatStore.setError("Not connected to server");
						return;
					}

					// Add user message to chat
					chatStore.addUserMessage(content, mode, attachments);
					chatStore.setIsProcessing(true);

					// Send to server
					socket.send(
						JSON.stringify({
							message: content,
							mode,
							attachments,
							skipWebSearch,
							thinkingMode,
							sessionId: sessionStore.currentSessionId,
						}),
					);
				},

				sendRaw: (data) => {
					const { socket, isConnected } = get();
					if (!isConnected || !socket) {
						console.warn("Cannot send: not connected");
						return;
					}
					socket.send(JSON.stringify(data));
				},

				// ------------------------------------------------------------------
				// Control Commands
				// ------------------------------------------------------------------

				stopGeneration: () => {
					const { socket, isConnected } = get();
					if (!isConnected || !socket) return;
					socket.send(JSON.stringify({ type: "stop" }));
					useChatStore.getState().setIsProcessing(false);
				},

				requestStats: () => {
					const { socket, isConnected } = get();
					if (!isConnected || !socket) return;
					socket.send(JSON.stringify({ type: "get_stats" }));
				},

				setSession: (sessionId) => {
					const { socket, isConnected } = get();
					const sessionStore = useSessionStore.getState();
					const chatStore = useChatStore.getState();

					sessionStore.setCurrentSession(sessionId);
					chatStore.clearMessages();

					if (isConnected && socket) {
						socket.send(JSON.stringify({ type: "set_session", sessionId }));
					}
				},

				// ------------------------------------------------------------------
				// Tool Confirmation
				// ------------------------------------------------------------------

				setPendingToolConfirmation: (request) => {
					set(
						{ pendingToolConfirmation: request },
						false,
						"setPendingToolConfirmation",
					);
				},

				handleToolConfirmation: (requestId, approved, remember) => {
					const state = get();
					const { pendingToolConfirmation } = state;
					if (!pendingToolConfirmation) return;

					if (state.isConnected && state.socket) {
						state.socket.send(
							JSON.stringify({
								type: "tool_confirmation_response",
								requestId,
								approved,
							}),
						);
					}

					if (approved && remember) {
						state.approveToolForSession(pendingToolConfirmation.toolName);
					}

					set(
						{ pendingToolConfirmation: null },
						false,
						"clearToolConfirmation",
					);
				},

				isToolApproved: (toolName) => {
					return get().approvedTools.has(toolName);
				},

				approveToolForSession: (toolName) => {
					set(
						(state) => ({
							approvedTools: new Set(state.approvedTools).add(toolName),
						}),
						false,
						"approveToolForSession",
					);
				},
			};
		},
		{ name: "websocket-store" },
	),
);
