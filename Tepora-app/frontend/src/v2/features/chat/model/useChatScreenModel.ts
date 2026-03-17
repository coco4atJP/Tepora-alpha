import { useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import {
	startTransition,
	useDeferredValue,
	useEffect,
	useReducer,
	useState,
} from "react";
import type { ApprovalDecision } from "../../../shared/contracts";
import { v2TransportAdapter } from "../../../shared/lib/transportAdapter";
import {
	useCreateSessionMutation,
	useV2SessionMessagesQuery,
	useV2SessionsQuery,
	v2SessionQueryKeys,
} from "../../session/model/queries";
import type { ChatScreenViewProps } from "../view/props";
import { prepareComposerFiles } from "./attachmentFiles";
import { chatFlowMachine } from "./chatMachine";
import {
	chatPipelineReducer,
	createInitialChatPipelineState,
} from "./messagePipeline";
import { useChatRuntimeStore } from "./runtimeStore";

type ComposerAttachmentRecord = ChatScreenViewProps["composer"]["attachments"][number] & {
	content: string;
	piiConfirmed?: boolean;
	piiFindings?: Array<{
		category: string;
		preview: string;
	}>;
};

export function useChatScreenModel(): ChatScreenViewProps & {
	onAddFiles: (files: readonly File[] | null) => Promise<void>;
} {
	const queryClient = useQueryClient();
	const selectedSessionId = useChatRuntimeStore((state) => state.selectedSessionId);
	const setSelectedSessionId = useChatRuntimeStore(
		(state) => state.setSelectedSessionId,
	);
	const activeMode = useChatRuntimeStore((state) => state.activeMode);
	const setActiveMode = useChatRuntimeStore((state) => state.setActiveMode);
	const draft = useChatRuntimeStore((state) => state.draft);
	const setDraft = useChatRuntimeStore((state) => state.setDraft);
	const thinkingBudget = useChatRuntimeStore((state) => state.thinkingBudget);
	const setThinkingBudget = useChatRuntimeStore(
		(state) => state.setThinkingBudget,
	);
	const connection = useChatRuntimeStore((state) => state.connection);
	const setConnection = useChatRuntimeStore((state) => state.setConnection);
	const setPanelState = useChatRuntimeStore((state) => state.setPanelState);
	const sharedToolConfirmation = useChatRuntimeStore(
		(state) => state.pendingToolConfirmation,
	);
	const clearToolConfirmation = useChatRuntimeStore(
		(state) => state.clearToolConfirmation,
	);
	const resetComposer = useChatRuntimeStore((state) => state.resetComposer);

	const sessionsQuery = useV2SessionsQuery();
	const messagesQuery = useV2SessionMessagesQuery(selectedSessionId);
	const createSessionMutation = useCreateSessionMutation();
	const [machineSnapshot, sendToMachine] = useMachine(chatFlowMachine);
	const [pipelineState, dispatchPipeline] = useReducer(
		chatPipelineReducer,
		undefined,
		createInitialChatPipelineState,
	);
	const [composerAttachments, setComposerAttachments] = useState<
		ComposerAttachmentRecord[]
	>([]);
	const [actionError, setActionError] = useState<string | null>(null);
	const deferredMessages = useDeferredValue(pipelineState.messages);

	const sessions = sessionsQuery.data ?? [];
	const sessionMessages = messagesQuery.data ?? [];
	const isBusy =
		machineSnapshot.matches("sending") ||
		machineSnapshot.matches("streaming") ||
		machineSnapshot.matches("awaitingToolConfirmation") ||
		createSessionMutation.isPending;

	useEffect(() => {
		void v2TransportAdapter.connect();
		const unsubscribeConnection = v2TransportAdapter.subscribeConnection(
			(snapshot) => {
				setConnection(snapshot);
				if (snapshot.status === "reconnecting") {
					sendToMachine({ type: "RECONNECT_INVALIDATED" });
				}
			},
		);
		const unsubscribeMessages = v2TransportAdapter.subscribe((message) => {
			switch (message.type) {
				case "chunk":
				case "thought":
					sendToMachine({
						type: "STREAM_EVENT",
						streamId: message.streamId,
					});
					break;
				case "tool_confirmation_request":
					sendToMachine({
						type: "TOOL_CONFIRMATION_REQUIRED",
						requestId: message.data.requestId,
					});
					break;
				case "done":
					sendToMachine({ type: "DONE" });
					break;
				case "stopped":
					sendToMachine({ type: "STOPPED" });
					break;
				case "error":
					sendToMachine({ type: "FAILED", message: message.message });
					break;
				case "interaction_complete":
					void queryClient.invalidateQueries({
						queryKey: v2SessionQueryKeys.sessionMessages(message.sessionId),
					});
					void queryClient.invalidateQueries({
						queryKey: v2SessionQueryKeys.sessions(),
					});
					break;
				case "session_changed":
					void queryClient.invalidateQueries({
						queryKey: v2SessionQueryKeys.sessionMessages(message.sessionId),
					});
					break;
			}

			dispatchPipeline({
				type: "TRANSPORT_MESSAGE",
				message,
			});
		});

		return () => {
			unsubscribeConnection();
			unsubscribeMessages();
			v2TransportAdapter.disconnect();
		};
	}, [queryClient, sendToMachine, setConnection]);

	useEffect(() => {
		if (selectedSessionId || sessions.length === 0) {
			return;
		}

		startTransition(() => {
			setSelectedSessionId(sessions[0].id);
		});
	}, [selectedSessionId, sessions, setSelectedSessionId]);

	useEffect(() => {
		sendToMachine({ type: "SESSION_CHANGED" });
		dispatchPipeline({ type: "RESET" });
		if (!selectedSessionId || connection.status !== "connected") {
			return;
		}

		try {
			v2TransportAdapter.send({
				type: "set_session",
				sessionId: selectedSessionId,
			});
		} catch {
			// Query-driven history hydration can proceed before the transport is ready.
		}
	}, [connection.status, selectedSessionId, sendToMachine]);

	useEffect(() => {
		if (!selectedSessionId || isBusy) {
			return;
		}

		startTransition(() => {
			dispatchPipeline({
				type: "HYDRATE_HISTORY",
				messages: sessionMessages,
			});
		});
	}, [isBusy, selectedSessionId, sessionMessages]);

	useEffect(() => {
		setPanelState({
			activity: pipelineState.activity,
			statusMessage: pipelineState.statusMessage,
			pendingToolConfirmation: pipelineState.pendingToolConfirmation,
		});
	}, [
		pipelineState.activity,
		pipelineState.pendingToolConfirmation,
		pipelineState.statusMessage,
		setPanelState,
	]);

	const handleCreateSession = async () => {
		setActionError(null);
		const session = await createSessionMutation.mutateAsync(null);
		startTransition(() => {
			setSelectedSessionId(session.id);
		});
	};

	const handleSend = async () => {
		setActionError(null);
		const content = draft.trim();
		if (content.length === 0) {
			return;
		}
		if (connection.status !== "connected") {
			setActionError("Transport is not connected.");
			return;
		}

		let sessionId = selectedSessionId;
		if (!sessionId) {
			const session = await createSessionMutation.mutateAsync(null);
			sessionId = session.id;
			startTransition(() => {
				setSelectedSessionId(session.id);
			});
		}

		const requestId = crypto.randomUUID();
		sendToMachine({ type: "SEND", requestId });
		dispatchPipeline({
			type: "APPEND_OPTIMISTIC_USER",
			message: {
				id: requestId,
				content,
				createdAt: new Date().toISOString(),
				mode: activeMode,
			},
		});

		try {
			if (sessionId) {
				v2TransportAdapter.send({
					type: "set_session",
					sessionId,
				});
			}
			v2TransportAdapter.send({
				clientMessageId: requestId,
				message: content,
				mode: activeMode,
				sessionId: sessionId ?? undefined,
				attachments: composerAttachments.map((attachment) => ({
					name: attachment.name,
					content: attachment.content,
					type: attachment.type,
					piiConfirmed: attachment.piiConfirmed,
					piiFindings: attachment.piiFindings,
				})),
				thinkingBudget,
			});
			resetComposer();
			setComposerAttachments([]);
		} catch (error) {
			sendToMachine({
				type: "FAILED",
				message: error instanceof Error ? error.message : "Failed to send message",
			});
			setActionError(
				error instanceof Error ? error.message : "Failed to send message",
			);
		}
	};

	const handleStop = () => {
		if (connection.status !== "connected") {
			return;
		}
		sendToMachine({ type: "STOP_REQUESTED" });
		v2TransportAdapter.send({
			type: "stop",
			sessionId: selectedSessionId ?? undefined,
		});
	};

	const handleRegenerate = async () => {
		if (!selectedSessionId || connection.status !== "connected") {
			setActionError("A connected session is required before regenerating.");
			return;
		}

		const requestId = crypto.randomUUID();
		sendToMachine({ type: "REGENERATE", requestId });
		v2TransportAdapter.send({
			type: "regenerate",
			sessionId: selectedSessionId,
		});
	};

	const handleRetryConnection = async () => {
		setActionError(null);
		await v2TransportAdapter.reconnect();
	};

	const handleToolDecision = async (
		decision: ApprovalDecision,
		ttlSeconds?: number,
	) => {
		const pendingTool = sharedToolConfirmation;
		if (!pendingTool) {
			return;
		}

		v2TransportAdapter.send({
			type: "tool_confirmation_response",
			requestId: pendingTool.requestId,
			decision,
			ttlSeconds,
		});
		clearToolConfirmation();
		dispatchPipeline({ type: "CLEAR_TOOL_CONFIRMATION" });
		sendToMachine({ type: "TOOL_CONFIRMATION_RESOLVED" });
	};

	const handleAddFiles = async (files: readonly File[] | null) => {
		if (!files || files.length === 0) {
			return;
		}

		setActionError(null);

		try {
			const prepared = await prepareComposerFiles(files);
			const blocked = prepared.filter(
				(attachment) => attachment.piiFindings.length > 0,
			);
			const safeAttachments = prepared.filter(
				(attachment) => attachment.piiFindings.length === 0,
			);

			if (blocked.length > 0) {
				setActionError(
					`Attachment blocked by PII detection: ${blocked
						.map((attachment) => attachment.name)
						.join(", ")}`,
				);
			}

			if (safeAttachments.length === 0) {
				return;
			}

			setComposerAttachments((current) => [
				...current,
				...safeAttachments.map((attachment) => ({
					id: crypto.randomUUID(),
					name: attachment.name,
					type: attachment.type,
					status: "attached" as const,
					content: attachment.content,
					piiConfirmed: false,
					piiFindings: attachment.piiFindings,
				})),
			]);
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : "Failed to read attachments",
			);
		}
	};

	const shellState: ChatScreenViewProps["shellState"] = sessionsQuery.isLoading
		? "loading"
		: sessionsQuery.error || messagesQuery.error
			? "error"
			: "ready";

	return {
		shellState,
		connectionState: connection.status,
		activeMode,
		draft,
		sessions: sessions.map((session) => ({
			id: session.id,
			title: session.title ?? "Untitled session",
			preview: session.preview ?? null,
			updatedAt: session.updated_at,
			messageCount: session.message_count ?? 0,
			isSelected: session.id === selectedSessionId,
		})),
		selectedSessionId,
		messages: deferredMessages,
		activity: pipelineState.activity,
		statusMessage: pipelineState.statusMessage,
		toolConfirmation: sharedToolConfirmation,
		composer: {
			attachments: composerAttachments,
			thinkingBudget,
			canSend: draft.trim().length > 0 && connection.status === "connected",
			canStop:
				machineSnapshot.matches("sending") || machineSnapshot.matches("streaming"),
			canRegenerate:
				selectedSessionId !== null &&
				!machineSnapshot.matches("sending") &&
				!machineSnapshot.matches("streaming"),
			isSending: isBusy,
		},
		errorMessage:
			actionError ??
			(connection.lastError ??
				(sessionsQuery.error as Error | null)?.message ??
				(messagesQuery.error as Error | null)?.message ??
				machineSnapshot.context.lastError),
		onDraftChange: setDraft,
		onModeChange: setActiveMode,
		onThinkingBudgetChange: setThinkingBudget,
		onSend: handleSend,
		onStop: handleStop,
		onRegenerate: handleRegenerate,
		onSelectSession: setSelectedSessionId,
		onCreateSession: handleCreateSession,
		onRetryConnection: handleRetryConnection,
		onToolDecision: handleToolDecision,
		onAddFiles: handleAddFiles,
		onRemoveAttachment: (attachmentId) => {
			setComposerAttachments((current) =>
				current.filter((attachment) => attachment.id !== attachmentId),
			);
		},
	};
}
