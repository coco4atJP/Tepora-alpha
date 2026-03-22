import { startTransition, useEffect } from "react";
import type { SessionHistoryMessage } from "../../../shared/contracts";
import type { WorkspaceActivityItem, WorkspaceToolConfirmation } from "../../../app/model/workspaceStore";
import { v2TransportAdapter, type V2TransportConnectionStatus } from "../../../shared/lib/transportAdapter";
import type { ChatFlowEvent } from "./chatMachine";
import type { ChatPipelineAction, ChatPipelineState } from "./messagePipeline";

interface UseChatSessionLifecycleParams {
	selectedSessionId: string | null;
	sessions: Array<{ id: string }>;
	setSelectedSessionId: (sessionId: string | null) => void;
	sendToMachine: (event: ChatFlowEvent) => void;
	dispatchPipeline: React.Dispatch<ChatPipelineAction>;
	connectionStatus: V2TransportConnectionStatus;
	isBusy: boolean;
	sessionMessages: SessionHistoryMessage[];
	pipelineState: Pick<
		ChatPipelineState,
		"activity" | "searchResults" | "statusMessage" | "pendingToolConfirmation"
	>;
	setPanelState: (patch: {
		statusMessage: string | null;
		activity: WorkspaceActivityItem[];
		searchResults: Array<{
			title: string;
			url: string;
			snippet: string;
		}>;
		pendingToolConfirmation: WorkspaceToolConfirmation | null;
	}) => void;
}

export function useChatSessionLifecycle({
	selectedSessionId,
	sessions,
	setSelectedSessionId,
	sendToMachine,
	dispatchPipeline,
	connectionStatus,
	isBusy,
	sessionMessages,
	pipelineState,
	setPanelState,
}: UseChatSessionLifecycleParams) {
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
		if (!selectedSessionId || connectionStatus !== "connected") {
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
	}, [connectionStatus, dispatchPipeline, selectedSessionId, sendToMachine]);

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
	}, [dispatchPipeline, isBusy, selectedSessionId, sessionMessages]);

	useEffect(() => {
		setPanelState({
			activity: pipelineState.activity,
			searchResults: pipelineState.searchResults,
			statusMessage: pipelineState.statusMessage,
			pendingToolConfirmation: pipelineState.pendingToolConfirmation,
		});
	}, [
		pipelineState.activity,
		pipelineState.pendingToolConfirmation,
		pipelineState.searchResults,
		pipelineState.statusMessage,
		setPanelState,
	]);
}
