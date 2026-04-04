import type { Session } from "../../../shared/contracts";
import type { V2TransportConnectionSnapshot } from "../../../shared/lib/transportAdapter";
import type { ChatScreenViewProps } from "../view/props";

export function resolveShellState(
	sessionsLoading: boolean,
	sessionsError: unknown,
	messagesError: unknown,
): ChatScreenViewProps["shellState"] {
	if (sessionsLoading) {
		return "loading";
	}
	if (sessionsError || messagesError) {
		return "error";
	}
	return "ready";
}

export function mapSessionsToViewModel(
	sessions: Session[],
	selectedSessionId: string | null,
): ChatScreenViewProps["sessions"] {
	return sessions.map((session) => ({
		id: session.id,
		title: session.title ?? "Untitled session",
		preview: session.preview ?? null,
		updatedAt: session.updated_at,
		messageCount: session.message_count ?? 0,
		isSelected: session.id === selectedSessionId,
	}));
}

export function buildComposerViewModel(params: {
	attachments: ChatScreenViewProps["composer"]["attachments"];
	thinkingBudget: number;
	searchMode: ChatScreenViewProps["composer"]["searchMode"];
	draft: string;
	connection: V2TransportConnectionSnapshot;
	isBusy: boolean;
	isStreaming: boolean;
	canAttachImages: boolean;
	selectedSessionId: string | null;
}): ChatScreenViewProps["composer"] {
	return {
		attachments: params.attachments.map(att => ({
			id: att.id,
			name: att.name,
			type: att.type,
			status: att.status,
			content: att.content,
		})),
		thinkingBudget: params.thinkingBudget,
		searchMode: params.searchMode,
		canSend:
			params.draft.trim().length > 0 && params.connection.status === "connected",
		canStop: params.isStreaming,
		canRegenerate:
			params.selectedSessionId !== null && !params.isStreaming,
		isSending: params.isBusy,
		canAttachImages: params.canAttachImages,
	};
}

export function resolveChatErrorMessage(params: {
	actionError: string | null;
	connection: V2TransportConnectionSnapshot;
	sessionsError: unknown;
	messagesError: unknown;
	machineError: string | null;
}): string | null {
	return (
		params.actionError ??
		params.connection.lastError ??
		(params.sessionsError as Error | null)?.message ??
		(params.messagesError as Error | null)?.message ??
		params.machineError
	);
}
