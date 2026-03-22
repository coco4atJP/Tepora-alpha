import type { ChatScreenViewProps } from "../view/props";
import {
	buildComposerViewModel,
	mapSessionsToViewModel,
	resolveChatErrorMessage,
	resolveShellState,
} from "./chatViewModel";
import { useChatComposerActions } from "./useChatComposerActions";
import { useChatScreenState } from "./useChatScreenState";
import { useChatSessionLifecycle } from "./useChatSessionLifecycle";
import { useChatTransportLifecycle } from "./useChatTransportLifecycle";

export function useChatScreenModel(): ChatScreenViewProps & {
	onAddFiles: (files: readonly File[] | null) => Promise<void>;
} {
	const {
		queryClient,
		selectedSessionId,
		setSelectedSessionId,
		activeMode,
		setActiveMode,
		draft,
		setDraft,
		searchMode,
		setSearchMode,
		thinkingBudget,
		setThinkingBudget,
		connection,
		setConnection,
		setPanelState,
		sharedToolConfirmation,
		clearToolConfirmation,
		resetComposer,
		sessionsQuery,
		messagesQuery,
		createSessionMutation,
		machineSnapshot,
		sendToMachine,
		pipelineState,
		dispatchPipeline,
		composerAttachments,
		setComposerAttachments,
		actionError,
		setActionError,
		deferredMessages,
		sessions,
		sessionMessages,
		isBusy,
		isStreaming,
	} = useChatScreenState();

	useChatTransportLifecycle({
		queryClient,
		sendToMachine,
		dispatchPipeline,
		setConnection,
	});

	useChatSessionLifecycle({
		selectedSessionId,
		sessions,
		setSelectedSessionId,
		sendToMachine,
		dispatchPipeline,
		connectionStatus: connection.status,
		isBusy,
		sessionMessages,
		pipelineState: {
			activity: pipelineState.activity,
			searchResults: pipelineState.searchResults,
			statusMessage: pipelineState.statusMessage,
			pendingToolConfirmation: pipelineState.pendingToolConfirmation,
		},
		setPanelState,
	});

	const {
		handleCreateSession,
		handleSend,
		handleStop,
		handleRegenerate,
		handleRetryConnection,
		handleToolDecision,
		handleAddFiles,
		handleRemoveAttachment,
	} = useChatComposerActions({
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
		createSession: createSessionMutation.mutateAsync,
	});

	const shellState = resolveShellState(
		sessionsQuery.isLoading,
		sessionsQuery.error,
		messagesQuery.error,
	);

	return {
		shellState,
		connectionState: connection.status,
		activeMode,
		draft,
		sessions: mapSessionsToViewModel(sessions, selectedSessionId),
		selectedSessionId,
		messages: deferredMessages,
		activity: pipelineState.activity,
		statusMessage: pipelineState.statusMessage,
		toolConfirmation: sharedToolConfirmation,
			composer: buildComposerViewModel({
				attachments: composerAttachments,
				thinkingBudget,
				searchMode,
				draft,
				connection,
				isBusy,
				isStreaming,
				selectedSessionId,
			}),
		errorMessage: resolveChatErrorMessage({
			actionError,
			connection,
			sessionsError: sessionsQuery.error,
			messagesError: messagesQuery.error,
			machineError: machineSnapshot.context.lastError,
		}),
		onDraftChange: setDraft,
		onModeChange: setActiveMode,
		onSearchModeChange: setSearchMode,
		onThinkingBudgetChange: setThinkingBudget,
		onSend: handleSend,
		onStop: handleStop,
		onRegenerate: handleRegenerate,
		onSelectSession: setSelectedSessionId,
		onCreateSession: handleCreateSession,
		onRetryConnection: handleRetryConnection,
		onToolDecision: handleToolDecision,
		onAddFiles: handleAddFiles,
		onRemoveAttachment: handleRemoveAttachment,
	};
}
