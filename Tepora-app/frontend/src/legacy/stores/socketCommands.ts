import type {
	ApprovalDecision,
	AgentMode,
	Attachment,
	ChatMode,
	ToolConfirmationRequest,
	ToolConfirmationResponse,
} from "../../types";
import { getWsBase } from "../../utils/api";
import { logger } from "../../utils/logger";
import { getSessionToken, refreshSessionToken } from "../../utils/sessionToken";
import { backendReady, isDesktop } from "../../utils/sidecar";
import { buildWebSocketProtocols } from "../../utils/wsAuth";
import { chatActor } from "../machines/chatMachine";
import { routeIncomingMessage } from "./messageRouter";
import { useChatStore } from "./chatStore";
import { useSessionStore } from "./sessionStore";
import { useSocketConnectionStore } from "./socketConnectionStore";
import { useToolConfirmationStore } from "./toolConfirmationStore";

const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;

type TransportMode = "ipc" | "websocket";

let isMounted = true;
let shouldReconnect = true;
let isConnecting = false;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let ipcUnsubscribe: (() => void) | null = null;
let activeTransportMode: TransportMode | null = null;

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

const resolveTransportMode = (): TransportMode => {
	const winMode =
		typeof window !== "undefined"
			? (window as Window & { __TRANSPORT_MODE__?: TransportMode }).__TRANSPORT_MODE__
			: undefined;
	if (winMode === "ipc" || winMode === "websocket") {
		return winMode;
	}
	return isDesktop() ? "ipc" : "websocket";
};

function sendPayload(data: Record<string, unknown>) {
	const { socket, isConnected } = useSocketConnectionStore.getState();
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
}

function sendToolConfirmationResponse(requestId: string, response: ToolConfirmationResponse) {
	const transportMode = activeTransportMode ?? resolveTransportMode();
	const state = useSocketConnectionStore.getState();
	if (!state.isConnected) return;

	if (transportMode === "ipc") {
		import("../transport/factory").then(({ getTransport }) => {
			getTransport("ipc").confirmTool(requestId, response);
		});
		return;
	}

	if (state.socket) {
		state.socket.send(
			JSON.stringify({
				type: "tool_confirmation_response",
				requestId,
				decision: response.decision,
				ttlSeconds: response.ttlSeconds,
			}),
		);
	}
}

export const socketCommands = {
	connect: async () => {
		isMounted = true;
		shouldReconnect = true;
		const desiredTransportMode = resolveTransportMode();
		const connectionStore = useSocketConnectionStore.getState();
		const existing = connectionStore.socket;

		if (desiredTransportMode === "ipc" && connectionStore.isConnected && activeTransportMode === "ipc") {
			return;
		}
		if (
			desiredTransportMode === "websocket" &&
			existing &&
			(existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
		) {
			return;
		}
		if (isConnecting) return;
		isConnecting = true;

		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = null;
		}

		try {
			if (isDesktop()) {
				await backendReady;
			}

			if (desiredTransportMode === "ipc") {
				if (ipcUnsubscribe) {
					ipcUnsubscribe();
					ipcUnsubscribe = null;
				}

				useSocketConnectionStore.getState().setConnection(true, null);
				useSocketConnectionStore.getState().setReconnectAttempts(0);
				activeTransportMode = "ipc";
				chatActor.send({ type: "RESET" });
				useChatStore.getState().setError(null);

				const sessionId = useSessionStore.getState().currentSessionId;
				socketCommands.setSession(sessionId);

				import("../transport/factory")
					.then(({ getTransport }) => {
						ipcUnsubscribe = getTransport("ipc").subscribe((data: unknown) => {
							routeIncomingMessage(JSON.stringify(data), {
								autoApproveToolConfirmation: (request) => {
									sendToolConfirmationResponse(request.requestId, { decision: "once" });
									useToolConfirmationStore.getState().clearPendingToolConfirmation();
								},
							});
						});
					})
					.catch((error) => {
						logger.error("Failed to initialize IPC transport subscription", error);
					});
				return;
			}

			const currentToken = await getSessionToken();
			const ws = new WebSocket(getWsUrl(), buildWebSocketProtocols(currentToken));

			ws.onopen = () => {
				if (!isMounted) {
					ws.close();
					return;
				}
				useSocketConnectionStore.getState().setConnection(true, ws);
				useSocketConnectionStore.getState().setReconnectAttempts(0);
				activeTransportMode = "websocket";
				chatActor.send({ type: "RESET" });
				useChatStore.getState().setError(null);
				const sessionId = useSessionStore.getState().currentSessionId;
				socketCommands.setSession(sessionId);
			};

			ws.onmessage = (event) => {
				routeIncomingMessage(event.data, {
					autoApproveToolConfirmation: (request) => {
						sendToolConfirmationResponse(request.requestId, { decision: "once" });
						useToolConfirmationStore.getState().clearPendingToolConfirmation();
					},
				});
			};

			ws.onerror = (error) => {
				if (!isMounted) return;
				logger.error("WebSocket error:", error);
			};

			ws.onclose = (event) => {
				if (!isMounted) return;
				useSocketConnectionStore.getState().setConnection(false, null);
				activeTransportMode = null;
				chatActor.send({ type: "RESET" });

				if (event.code === 4001 || event.code === 1006) {
					refreshSessionToken().catch(logger.warn);
				}

				const attempts = useSocketConnectionStore.getState().reconnectAttempts;
				const delay = calculateBackoff(attempts);
				logger.log(`WebSocket disconnected. Reconnecting in ${Math.round(delay)}ms`);
				reconnectTimeout = setTimeout(() => {
					if (isMounted) {
						useSocketConnectionStore.getState().setReconnectAttempts(attempts + 1);
						void socketCommands.connect();
					}
				}, delay);
			};

			useSocketConnectionStore.getState().setConnection(false, ws);
		} catch (error) {
			if (!isMounted) return;
			logger.error("WebSocket connection failed:", error);
			useSocketConnectionStore.getState().setConnection(false, connectionStore.socket);
			activeTransportMode = null;

			if (!shouldReconnect) return;
			const attempts = useSocketConnectionStore.getState().reconnectAttempts;
			const delay = calculateBackoff(attempts);
			reconnectTimeout = setTimeout(() => {
				if (isMounted) {
					useSocketConnectionStore.getState().setReconnectAttempts(attempts + 1);
					void socketCommands.connect();
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
		const { socket } = useSocketConnectionStore.getState();
		if (socket) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			socket.close();
		}
		useSocketConnectionStore.getState().reset();
	},

	sendMessage: (
		content: string,
		mode: ChatMode,
		attachments: Attachment[] = [],
		skipWebSearch = false,
		thinkingBudget = 0,
		agentId?: string,
		agentMode?: AgentMode,
		timeout?: number,
	) => {
		const { isConnected } = useSocketConnectionStore.getState();
		const chatStore = useChatStore.getState();
		const sessionStore = useSessionStore.getState();
		const transportMode = activeTransportMode ?? resolveTransportMode();
		const { socket } = useSocketConnectionStore.getState();

		if (!isConnected || (transportMode !== "ipc" && !socket)) {
			chatStore.setError("Not connected to server");
			return;
		}

		chatStore.addUserMessage(content, mode, attachments);

		sendPayload({
			message: content,
			mode,
			attachments,
			skipWebSearch,
			thinkingBudget,
			agentId,
			agentMode,
			sessionId: sessionStore.currentSessionId,
			timeout,
		});
	},

	sendRaw: (data: Record<string, unknown>) => {
		sendPayload(data);
	},

	stopGeneration: () => {
		if (!useSocketConnectionStore.getState().isConnected) return;
		sendPayload({
			type: "stop",
			sessionId: useSessionStore.getState().currentSessionId,
		});
		chatActor.send({ type: "DONE" });
	},

	requestStats: () => {
		if (!useSocketConnectionStore.getState().isConnected) return;
		sendPayload({ type: "get_stats" });
	},

	setSession: (sessionId: string) => {
		const sessionStore = useSessionStore.getState();
		const chatStore = useChatStore.getState();
		sessionStore.setCurrentSession(sessionId);
		chatStore.clearMessages();
		if (useSocketConnectionStore.getState().isConnected) {
			sendPayload({ type: "set_session", sessionId });
		}
	},

	regenerateResponse: () => {
		const chatStore = useChatStore.getState();
		const { isConnected, socket } = useSocketConnectionStore.getState();
		const transportMode = activeTransportMode ?? resolveTransportMode();

		if (!isConnected || (transportMode !== "ipc" && !socket)) {
			chatStore.setError("Not connected to server");
			return;
		}

		const messages = chatStore.messages;
		let lastUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (messages[index].role === "user") {
				lastUserIndex = index;
				break;
			}
		}
		if (lastUserIndex === -1) return;

		chatStore.setMessages(messages.slice(0, lastUserIndex + 1));
		sendPayload({
			type: "regenerate",
			sessionId: useSessionStore.getState().currentSessionId,
		});
	},

	handleToolConfirmation: (requestId: string, decision: ApprovalDecision, ttlSeconds?: number) => {
		const pendingToolConfirmation = useToolConfirmationStore.getState().pendingToolConfirmation;
		if (!pendingToolConfirmation) return;

		sendToolConfirmationResponse(requestId, { decision, ttlSeconds });
		useToolConfirmationStore.getState().clearPendingToolConfirmation();
	},

	autoApproveToolConfirmation: (request: ToolConfirmationRequest) => {
		sendToolConfirmationResponse(request.requestId, { decision: "once" });
		useToolConfirmationStore.getState().clearPendingToolConfirmation();
	},
};

