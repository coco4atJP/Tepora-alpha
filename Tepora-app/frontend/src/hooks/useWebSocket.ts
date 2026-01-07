import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment, ChatMode, Message } from "../types";
import { useChatState } from "./chat/useChatState";
import { useMessageBuffer } from "./chat/useMessageBuffer";
import { useSocketConnection } from "./chat/useSocketConnection";
import { useWebSocketMessageHandlers } from "./chat/useWebSocketMessageHandlers";

export const useWebSocket = () => {
	const {
		messages,
		setMessages,
		searchResults,
		setSearchResults,
		activityLog,
		setActivityLog,
		isProcessing,
		setIsProcessing,
		memoryStats,
		setMemoryStats,
		error,
		setError,
		clearMessages,
		clearError,
		// Tool confirmation
		pendingToolConfirmation,
		setPendingToolConfirmation,
		approveToolForSession,
		isToolApproved,
	} = useChatState();

	const { handleChunk, flushAndClose } = useMessageBuffer(setMessages);

	// Session management
	const [currentSessionId, setCurrentSessionIdState] =
		useState<string>("default");
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);

	// Create message handlers using the new separated hook
	const { handleMessage: onMessage } = useWebSocketMessageHandlers({
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
	});

	// Define callbacks before passing to useSocketConnection
	const handleOpen = useCallback(() => {
		setIsProcessing(false);
		setError(null);
	}, [setIsProcessing, setError]);

	const handleError = useCallback(() => {
		setError("Connection error");
	}, [setError]);

	const handleClose = useCallback(() => {
		setIsProcessing(false);
	}, [setIsProcessing]);

	const { isConnected, sendMessage: sendRaw } = useSocketConnection({
		onOpen: handleOpen,
		onMessage,
		onError: handleError,
		onClose: handleClose,
	});

	// 接続確立時の初回履歴読み込み用フラグ
	const hasLoadedInitialHistory = useRef(false);

	// UX改善1: 接続確立時に現在セッションの履歴を自動読み込み
	useEffect(() => {
		if (isConnected && !hasLoadedInitialHistory.current) {
			sendRaw(
				JSON.stringify({ type: "set_session", sessionId: currentSessionId }),
			);
			hasLoadedInitialHistory.current = true;
			if (import.meta.env.DEV) {
				console.log("Auto-loading history for session:", currentSessionId);
			}
		}
		if (!isConnected) {
			hasLoadedInitialHistory.current = false;
		}
	}, [isConnected, sendRaw, currentSessionId]);

	const sendMessage = useCallback(
		(
			content: string,
			mode: ChatMode = "direct",
			attachments: Attachment[] = [],
			skipWebSearch: boolean = false,
		) => {
			if (!isConnected) {
				setError("Not connected to server");
				return;
			}

			const userMessage: Message = {
				id: Date.now().toString(),
				role: "user",
				content,
				timestamp: new Date(),
				mode,
			};
			setMessages((prev) => [...prev, userMessage]);
			setActivityLog([]);
			setError(null);

			setIsProcessing(true);
			sendRaw(
				JSON.stringify({
					message: content,
					mode,
					attachments,
					skipWebSearch,
					sessionId: currentSessionId,
				}),
			);
		},
		[
			isConnected,
			setMessages,
			setActivityLog,
			setError,
			setIsProcessing,
			sendRaw,
			currentSessionId,
		],
	);

	const requestStats = useCallback(() => {
		if (!isConnected) {
			return;
		}
		sendRaw(JSON.stringify({ type: "get_stats" }));
	}, [isConnected, sendRaw]);

	const stopGeneration = useCallback(() => {
		if (!isConnected) {
			return;
		}
		sendRaw(JSON.stringify({ type: "stop" }));
		setIsProcessing(false);
	}, [isConnected, sendRaw, setIsProcessing]);

	const setCurrentSessionId = useCallback(
		(sessionId: string) => {
			setCurrentSessionIdState(sessionId);
			setIsLoadingHistory(true);
			clearMessages();
			if (isConnected) {
				sendRaw(JSON.stringify({ type: "set_session", sessionId }));
			}
		},
		[isConnected, sendRaw, clearMessages],
	);

	const handleToolConfirmation = useCallback(
		(requestId: string, approved: boolean, remember: boolean) => {
			if (!pendingToolConfirmation) return;

			if (isConnected) {
				sendRaw(
					JSON.stringify({
						type: "tool_confirmation_response",
						requestId: requestId,
						approved: approved,
					}),
				);
				if (import.meta.env.DEV) {
					console.log(
						`Sent tool confirmation: requestId=${requestId}, approved=${approved}`,
					);
				}
			}

			if (approved && remember) {
				approveToolForSession(pendingToolConfirmation.toolName);
			}

			setPendingToolConfirmation(null);
		},
		[
			pendingToolConfirmation,
			approveToolForSession,
			setPendingToolConfirmation,
			isConnected,
			sendRaw,
		],
	);

	return {
		messages,
		searchResults,
		activityLog,
		isConnected,
		isProcessing,
		memoryStats,
		error,
		sendMessage,
		clearMessages,
		requestStats,
		clearError,
		stopGeneration,
		// Tool confirmation
		pendingToolConfirmation,
		handleToolConfirmation,
		// Session management
		currentSessionId,
		setCurrentSessionId,
		isLoadingHistory,
	};
};
