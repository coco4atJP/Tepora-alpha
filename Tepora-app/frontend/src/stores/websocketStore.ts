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
import type { ApprovalDecision, AgentMode, Attachment, ChatMode, ToolConfirmationRequest, ToolConfirmationResponse } from "../types";
import { getWsBase } from "../utils/api";
import { getSessionToken, refreshSessionToken } from "../utils/sessionToken";
import { backendReady, isDesktop } from "../utils/sidecar";
import { buildWebSocketProtocols } from "../utils/wsAuth";
import { logger } from "../utils/logger";
import { useChatStore } from "./chatStore";
import { useSessionStore } from "./sessionStore";
import { chatActor } from "../machines/chatMachine";

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
		thinkingBudget?: number,
		agentId?: string,
		agentMode?: AgentMode,
		timeout?: number,
	) => void;
	sendRaw: (data: Record<string, unknown>) => void;

	// Control commands
	stopGeneration: () => void;
	requestStats: () => void;
	setSession: (sessionId: string) => void;
	regenerateResponse: () => void;

	// Tool confirmation
	setPendingToolConfirmation: (request: ToolConfirmationRequest | null) => void;
	handleToolConfirmation: (requestId: string, decision: ApprovalDecision, ttlSeconds?: number) => void;
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

const getWsUrl = (): string => {
	let baseUrl: string;
	if (isDesktop()) {
		baseUrl = `${getWsBase()}/ws`;
	} else {
		baseUrl = import.meta.env.VITE_WS_URL || `${getWsBase()}/ws`;
	}
	return baseUrl;
};

const calculateBackoff = (attempt: number): number => {
	const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** attempt, MAX_RECONNECT_DELAY);
	const jitter = delay * 0.1 * (Math.random() * 2 - 1);
	return delay + jitter;
};

type TransportMode = "ipc" | "websocket";

const resolveTransportMode = (): TransportMode => {
	const winMode =
		typeof window !== "undefined" ? window.__TRANSPORT_MODE__ : undefined;
	if (winMode === "ipc" || winMode === "websocket") {
		return winMode;
	}
	return isDesktop() ? "ipc" : "websocket";
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
	supervisor: "Supervisor",
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
			let ipcUnsubscribe: (() => void) | null = null;
			let activeTransportMode: TransportMode | null = null;

			// Helper to handle incoming messages
			const handleMessage = (event: MessageEvent) => {
				try {
					const data = JSON.parse(event.data);
					const chatStore = useChatStore.getState();
					const sessionStore = useSessionStore.getState();

					switch (data.type) {
						case "chunk":
							chatActor.send({
								type: "RECV_CHUNK",
								payload: data.message || data.text || "",
								metadata: {
									mode: data.mode,
									agentName: data.agentName,
									nodeId: data.nodeId,
								},
							});
							break;

						case "done":
							chatActor.send({ type: "DONE" });
							// Session refresh is now triggered by interaction_complete
							// to ensure DB writes are fully committed
							break;

						case "interaction_complete":
							// Trigger session refresh event after all DB writes are complete
							window.dispatchEvent(new CustomEvent("session-refresh"));
							break;

						case "memory_generation":
							chatStore.setIsGeneratingMemory(data.status === "started");
							break;

						case "thought":
							if (data.content) {
								chatStore.updateMessageThinking(data.content);
							}
							break;

						case "stopped":
							chatActor.send({ type: "DONE" });
							break;

						case "error":
							chatStore.setError(data.message || "Unknown error");
							chatStore.addMessage({
								id: Date.now().toString(),
								role: "system",
								content: `Error: ${data.message || "Unknown error"}`,
								timestamp: new Date(),
							});
							chatActor.send({ type: "ERROR", error: new Error(data.message || "Unknown error") });
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
								const agentName = rawEntry.agentName || AGENT_MAPPING[rawEntry.id] || rawEntry.id;
								const statusMap: Record<string, "pending" | "processing" | "completed" | "error"> =
								{
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
								set({ pendingToolConfirmation: request }, false, "setToolConfirmation");
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
								logger.log(`Session switched to ${data.sessionId}`);
							}
							break;

						case "download_progress":
							if (data.data) {
								window.dispatchEvent(new CustomEvent("download-progress", { detail: data.data }));
							}
							break;
					}
				} catch (error) {
					logger.error("WebSocket message parse error:", error);
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
					const desiredTransportMode = resolveTransportMode();

					// Idempotent: don't create multiple sockets
					const existing = get().socket;
					if (desiredTransportMode === "ipc" && get().isConnected && activeTransportMode === "ipc") {
						return;
					}
					if (
						desiredTransportMode === "websocket" &&
						existing &&
						(existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
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

						if (desiredTransportMode === "ipc") {
							if (ipcUnsubscribe) {
								ipcUnsubscribe();
								ipcUnsubscribe = null;
							}

							// Bypass actual websocket connection and use IPC transport directly
							set({ isConnected: true, socket: null, reconnectAttempts: 0 }, false, "connected");
							activeTransportMode = "ipc";
							chatActor.send({ type: "RESET" });
							useChatStore.getState().setError(null);

							// Load initial history
							const sessionId = useSessionStore.getState().currentSessionId;
							get().setSession(sessionId);

							// Dynamically import and subscribe to IPC messages
							import("../transport/factory")
								.then(({ getTransport }) => {
									ipcUnsubscribe = getTransport("ipc").subscribe((data: unknown) => {
										handleMessage({ data: JSON.stringify(data) } as MessageEvent);
									});
								})
								.catch((error) => {
									logger.error("Failed to initialize IPC transport subscription", error);
								});
							return;
						}

						// Always get the freshest token
						const currentToken = await getSessionToken();

						const wsUrl = getWsUrl();
						const ws = new WebSocket(wsUrl, buildWebSocketProtocols(currentToken));

						ws.onopen = () => {
							if (!isMounted) {
								ws.close();
								return;
							}
							set({ isConnected: true, socket: ws, reconnectAttempts: 0 }, false, "connected");
							activeTransportMode = "websocket";
							chatActor.send({ type: "RESET" });
							useChatStore.getState().setError(null);

							// Load initial history
							const sessionId = useSessionStore.getState().currentSessionId;
							get().setSession(sessionId);
						};

						ws.onmessage = handleMessage;

						ws.onerror = (error) => {
							if (!isMounted) return;
							logger.error("WebSocket error:", error);
						};

						ws.onclose = (event) => {
							if (!isMounted) return;
							set({ isConnected: false, socket: null }, false, "disconnected");
							activeTransportMode = null;
							chatActor.send({ type: "RESET" });

							// Handle auth failure
							if (event.code === 4001 || event.code === 1006) {
								refreshSessionToken().catch(logger.warn);
							}

							// Reconnect with backoff
							const attempts = get().reconnectAttempts;
							const delay = calculateBackoff(attempts);
							logger.log(`WebSocket disconnected. Reconnecting in ${Math.round(delay)}ms`);

							reconnectTimeout = setTimeout(() => {
								if (isMounted) {
									set({ reconnectAttempts: attempts + 1 }, false, "reconnectAttempt");
									get().connect();
								}
							}, delay);
						};

						set({ socket: ws }, false, "socketCreated");
					} catch (error) {
						if (!isMounted) return;
						logger.error("WebSocket connection failed:", error);
						set({ isConnected: false }, false, "connectionFailed");
						activeTransportMode = null;

						// Retry on failure (unless explicitly disconnected)
						if (!shouldReconnect) return;
						const attempts = get().reconnectAttempts;
						const delay = calculateBackoff(attempts);
						reconnectTimeout = setTimeout(() => {
							if (isMounted) {
								set({ reconnectAttempts: attempts + 1 }, false, "reconnectAttempt");
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
					activeTransportMode = null;
					if (reconnectTimeout) {
						clearTimeout(reconnectTimeout);
						reconnectTimeout = null;
					}
					if (ipcUnsubscribe) {
						ipcUnsubscribe();
						ipcUnsubscribe = null;
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
					thinkingBudget = 0,
					agentId,
					agentMode,
					timeout,
				) => {
					const { socket, isConnected } = get();
					const chatStore = useChatStore.getState();
					const sessionStore = useSessionStore.getState();
					const transportMode = activeTransportMode ?? resolveTransportMode();

					if (!isConnected || (transportMode !== "ipc" && !socket)) {
						chatStore.setError("Not connected to server");
						return;
					}

					// Add user message to chat
					chatStore.addUserMessage(content, mode, attachments);
					// State transition triggered directly via UI button using chatActor.send

					const payload = {
						message: content,
						mode,
						attachments,
						skipWebSearch,
						thinkingBudget,
						agentId,
						agentMode,
						sessionId: sessionStore.currentSessionId,
						timeout,
					};

					if (transportMode === "ipc") {
						import("../transport/factory").then(({ getTransport }) => {
							getTransport("ipc").send(payload);
						});
					} else if (socket) {
						socket.send(JSON.stringify(payload));
					}
				},

				sendRaw: (data) => {
					const { socket, isConnected } = get();
					const transportMode = activeTransportMode ?? resolveTransportMode();
					if (!isConnected) {
						logger.warn("Cannot send: not connected");
						return;
					}
					if (transportMode === "ipc") {
						import("../transport/factory").then(({ getTransport }) => {
							getTransport("ipc").send(data);
						});
						return;
					}
					if (!socket) {
						logger.warn("Cannot send: websocket unavailable");
						return;
					}
					socket.send(JSON.stringify(data));
				},

				// ------------------------------------------------------------------
				// Control Commands
				// ------------------------------------------------------------------

				stopGeneration: () => {
					const { socket, isConnected } = get();
					const transportMode = activeTransportMode ?? resolveTransportMode();
					const sessionId = useSessionStore.getState().currentSessionId;

					if (!isConnected) return;

					const payload = { type: "stop", sessionId };
					if (transportMode === "ipc") {
						import("../transport/factory").then(({ getTransport }) => {
							getTransport("ipc").send(payload);
						});
					} else if (socket) {
						socket.send(JSON.stringify(payload));
					}
					chatActor.send({ type: "DONE" });
				},

				requestStats: () => {
					const { socket, isConnected } = get();
					const transportMode = activeTransportMode ?? resolveTransportMode();
					if (!isConnected) return;

					if (transportMode === "ipc") {
						import("../transport/factory").then(({ getTransport }) => {
							getTransport("ipc").send({ type: "get_stats" });
						});
					} else if (socket) {
						socket.send(JSON.stringify({ type: "get_stats" }));
					}
				},

				setSession: (sessionId) => {
					const { socket, isConnected } = get();
					const sessionStore = useSessionStore.getState();
					const chatStore = useChatStore.getState();
					const transportMode = activeTransportMode ?? resolveTransportMode();

					sessionStore.setCurrentSession(sessionId);
					chatStore.clearMessages();

					if (isConnected) {
						const payload = { type: "set_session", sessionId };
						if (transportMode === "ipc") {
							import("../transport/factory").then(({ getTransport }) => {
								getTransport("ipc").send(payload);
							});
						} else if (socket) {
							socket.send(JSON.stringify(payload));
						}
					}
				},

				regenerateResponse: () => {
					const { socket, isConnected } = get();
					const chatStore = useChatStore.getState();
					const sessionStore = useSessionStore.getState();
					const transportMode = activeTransportMode ?? resolveTransportMode();

					if (!isConnected || (transportMode !== "ipc" && !socket)) {
						chatStore.setError("Not connected to server");
						return;
					}

					// Update local messages: remove trailing AI/system messages
					const messages = chatStore.messages;
					let lastUserIndex = -1;
					for (let i = messages.length - 1; i >= 0; i--) {
						if (messages[i].role === "user") {
							lastUserIndex = i;
							break;
						}
					}

					if (lastUserIndex !== -1) {
						chatStore.setMessages(messages.slice(0, lastUserIndex + 1));
					} else {
						// Do nothing if no user message is found to regenerate from
						return;
					}

					const payload = {
						type: "regenerate",
						sessionId: sessionStore.currentSessionId,
					};

					if (transportMode === "ipc") {
						import("../transport/factory").then(({ getTransport }) => {
							getTransport("ipc").send(payload);
						});
					} else if (socket) {
						socket.send(JSON.stringify(payload));
					}
				},

				// ------------------------------------------------------------------
				// Tool Confirmation
				// ------------------------------------------------------------------

				setPendingToolConfirmation: (request) => {
					set({ pendingToolConfirmation: request }, false, "setPendingToolConfirmation");
				},

				handleToolConfirmation: (requestId, decision, ttlSeconds) => {
					const state = get();
					const { pendingToolConfirmation } = state;
					const transportMode = activeTransportMode ?? resolveTransportMode();
					const response: ToolConfirmationResponse = {
						decision,
						ttlSeconds,
					};

					if (!pendingToolConfirmation) return;

					if (state.isConnected) {
						if (transportMode === "ipc") {
							import("../transport/factory").then(({ getTransport }) => {
								getTransport("ipc").confirmTool(requestId, response);
							});
						} else if (state.socket) {
							state.socket.send(
								JSON.stringify({
									type: "tool_confirmation_response",
									requestId,
									decision,
									ttlSeconds,
								}),
							);
						}
					}

					set({ pendingToolConfirmation: null }, false, "clearToolConfirmation");
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

