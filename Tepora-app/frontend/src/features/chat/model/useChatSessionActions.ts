import { startTransition } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ApprovalDecision, ChatMode, SearchMode, Session } from "../../../shared/contracts";
import {
	v2TransportAdapter,
	type V2TransportConnectionSnapshot,
} from "../../../shared/lib/transportAdapter";
import type { ChatScreenViewProps } from "../view/props";
import type { ComposerAttachmentRecord } from "./chatComposerTypes";
import type { ChatFlowEvent } from "./chatMachine";
import type { ChatPipelineAction } from "./messagePipeline";

interface UseChatSessionActionsParams {
	selectedSessionId: string | null;
	setSelectedSessionId: (sessionId: string | null) => void;
	activeMode: ChatMode;
	draft: string;
	searchMode: SearchMode;
	thinkingBudget: number;
	connection: V2TransportConnectionSnapshot;
	composerAttachments: ComposerAttachmentRecord[];
	setComposerAttachments: Dispatch<SetStateAction<ComposerAttachmentRecord[]>>;
	sharedToolConfirmation: ChatScreenViewProps["toolConfirmation"];
	clearToolConfirmation: () => void;
	resetComposer: () => void;
	sendToMachine: (event: ChatFlowEvent) => void;
	dispatchPipeline: Dispatch<ChatPipelineAction>;
	setActionError: Dispatch<SetStateAction<string | null>>;
	createSession: (title?: string | null) => Promise<Session>;
}

export function useChatSessionActions({
	selectedSessionId,
	setSelectedSessionId,
	activeMode,
	draft,
	searchMode,
	thinkingBudget,
	connection,
	composerAttachments,
	setComposerAttachments,
	sharedToolConfirmation,
	clearToolConfirmation,
	resetComposer,
	sendToMachine,
	dispatchPipeline,
	setActionError,
	createSession,
}: UseChatSessionActionsParams) {
	const handleCreateSession = async () => {
		setActionError(null);
		const session = await createSession(null);
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
			const session = await createSession(null);
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
				searchMode: activeMode === "search" ? searchMode : undefined,
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

	return {
		handleCreateSession,
		handleSend,
		handleStop,
		handleRegenerate,
		handleRetryConnection,
		handleToolDecision,
	};
}
