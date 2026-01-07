import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type {
	ActivityLogEntry,
	AgentActivity,
	MemoryStats,
	Message,
	SearchResult,
	ToolConfirmationRequest,
	WebSocketMessage,
} from "../../types";

const AGENT_MAPPING: Record<string, string> = {
	generate_order: "Planner",
	generate_search_query: "Search Analyst",
	execute_search: "Search Tool",
	summarize_search_result: "Researcher",
	agent_reasoning: "Executor",
	tool_node: "Tool Handler",
	synthesize_final_response: "Synthesizer",
	update_scratchpad: "Memory Manager",
};

export interface MessageHandlerDependencies {
	handleChunk: (data: WebSocketMessage) => void;
	flushAndClose: () => void;
	setIsProcessing: (value: boolean) => void;
	setError: (value: string | null) => void;
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setMemoryStats: (value: MemoryStats | null) => void;
	setSearchResults: (value: SearchResult[]) => void;
	setActivityLog: React.Dispatch<React.SetStateAction<AgentActivity[]>>;
	setIsLoadingHistory: (value: boolean) => void;
	isToolApproved: (toolName: string) => boolean;
	setPendingToolConfirmation: (request: ToolConfirmationRequest | null) => void;
}

/**
 * Creates WebSocket message handlers for different message types.
 * This separates the message handling logic from the main useWebSocket hook.
 */
export const useWebSocketMessageHandlers = (
	deps: MessageHandlerDependencies,
) => {
	const { t } = useTranslation();

	// Destructure deps for cleaner dependency arrays
	const {
		handleChunk,
		flushAndClose,
		setIsProcessing,
		setError,
		setMessages,
		setMemoryStats,
		setSearchResults,
		setActivityLog,
		setIsLoadingHistory,
		isToolApproved,
		setPendingToolConfirmation,
	} = deps;

	const handleChunkMessage = useCallback(
		(data: WebSocketMessage) => {
			handleChunk(data);
		},
		[handleChunk],
	);

	const handleDoneMessage = useCallback(() => {
		flushAndClose();
		setIsProcessing(false);
		// セッションリストのリフレッシュを通知
		window.dispatchEvent(new CustomEvent("session-refresh"));
	}, [flushAndClose, setIsProcessing]);

	const handleStoppedMessage = useCallback(() => {
		flushAndClose();
		setIsProcessing(false);
	}, [flushAndClose, setIsProcessing]);

	const handleErrorMessage = useCallback(
		(data: WebSocketMessage) => {
			const errorMessageStr = data.message || "Unknown error";
			setError(errorMessageStr);

			const errorMessage: Message = {
				id: Date.now().toString(),
				role: "system",
				content: `${t("common.error_prefix", "Error: ")}${errorMessageStr}`,
				timestamp: new Date(),
			};
			setMessages((prev) => [...prev, errorMessage]);
			setIsProcessing(false);
		},
		[setError, setMessages, setIsProcessing, t],
	);

	const handleStatsMessage = useCallback(
		(data: WebSocketMessage) => {
			if (data.data) {
				setMemoryStats(data.data as MemoryStats);
			}
		},
		[setMemoryStats],
	);

	const handleSearchResultsMessage = useCallback(
		(data: WebSocketMessage) => {
			if (data.data && Array.isArray(data.data)) {
				setSearchResults(data.data as SearchResult[]);
			}
		},
		[setSearchResults],
	);

	const handleActivityMessage = useCallback(
		(data: WebSocketMessage) => {
			if (!data.data) return;

			const rawEntry = data.data as unknown as ActivityLogEntry;
			const agentName = AGENT_MAPPING[rawEntry.id] || rawEntry.id;
			const statusMap: Record<string, AgentActivity["status"]> = {
				done: "completed",
				processing: "processing",
				pending: "pending",
				error: "error",
			};

			setActivityLog((prev) => {
				const existingIndex = prev.findIndex((e) => e.agent_name === agentName);

				const newEntry: AgentActivity = {
					status: statusMap[rawEntry.status] || "processing",
					agent_name: agentName,
					details: rawEntry.message,
					step:
						existingIndex !== -1 ? prev[existingIndex].step : prev.length + 1,
				};

				if (existingIndex !== -1) {
					const newLog = [...prev];
					newLog[existingIndex] = newEntry;
					return newLog;
				}
				return [...prev, newEntry];
			});
		},
		[setActivityLog],
	);

	const handleToolConfirmationMessage = useCallback(
		(data: WebSocketMessage) => {
			if (!data.data) return;

			const request = data.data as ToolConfirmationRequest;
			if (isToolApproved(request.toolName)) {
				if (import.meta.env.DEV) {
					console.log(`Tool ${request.toolName} auto-approved (session cache)`);
				}
			} else {
				setPendingToolConfirmation(request);
			}
		},
		[isToolApproved, setPendingToolConfirmation],
	);

	const handleHistoryMessage = useCallback(
		(data: WebSocketMessage) => {
			if (data.messages && Array.isArray(data.messages)) {
				if (import.meta.env.DEV) {
					console.log(`Received ${data.messages.length} history messages`);
				}
				const parsedMessages = data.messages.map((msg) => ({
					...msg,
					timestamp: new Date(msg.timestamp),
				}));
				setMessages(parsedMessages);
			}
			setIsLoadingHistory(false);
		},
		[setMessages, setIsLoadingHistory],
	);

	const handleSessionChangedMessage = useCallback((data: WebSocketMessage) => {
		if (import.meta.env.DEV) {
			console.log(`Session switched to ${data.sessionId}`);
		}
	}, []);

	const handleDownloadProgressMessage = useCallback(
		(data: WebSocketMessage) => {
			if (data.data) {
				const event = new CustomEvent("download-progress", {
					detail: data.data,
				});
				window.dispatchEvent(event);
			}
		},
		[],
	);

	/**
	 * Main message handler that routes messages to specific handlers
	 */
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			try {
				const data: WebSocketMessage = JSON.parse(event.data);

				switch (data.type) {
					case "chunk":
						handleChunkMessage(data);
						break;
					case "done":
						handleDoneMessage();
						break;
					case "status":
						// Status messages don't affect visible state
						break;
					case "stopped":
						handleStoppedMessage();
						break;
					case "error":
						handleErrorMessage(data);
						break;
					case "stats":
						handleStatsMessage(data);
						break;
					case "search_results":
						handleSearchResultsMessage(data);
						break;
					case "activity":
						handleActivityMessage(data);
						break;
					case "tool_confirmation_request":
						handleToolConfirmationMessage(data);
						break;
					case "history":
						handleHistoryMessage(data);
						break;
					case "session_changed":
						handleSessionChangedMessage(data);
						break;
					case "download_progress":
						handleDownloadProgressMessage(data);
						break;
				}
			} catch (error) {
				console.error("WebSocket message parse error:", error);
				setError("Failed to parse server message");
			}
		},
		[
			handleChunkMessage,
			handleDoneMessage,
			handleStoppedMessage,
			handleErrorMessage,
			handleStatsMessage,
			handleSearchResultsMessage,
			handleActivityMessage,
			handleToolConfirmationMessage,
			handleHistoryMessage,
			handleSessionChangedMessage,
			handleDownloadProgressMessage,
			setError,
		],
	);

	return { handleMessage };
};
