import { useChatRuntimeStore } from "./runtimeStore";

export function useChatRuntimeBindings() {
	const selectedSessionId = useChatRuntimeStore((state) => state.selectedSessionId);
	const setSelectedSessionId = useChatRuntimeStore(
		(state) => state.setSelectedSessionId,
	);
	const activeMode = useChatRuntimeStore((state) => state.activeMode);
	const setActiveMode = useChatRuntimeStore((state) => state.setActiveMode);
	const draft = useChatRuntimeStore((state) => state.draft);
	const setDraft = useChatRuntimeStore((state) => state.setDraft);
	const searchMode = useChatRuntimeStore((state) => state.searchMode);
	const setSearchMode = useChatRuntimeStore((state) => state.setSearchMode);
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

	return {
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
	};
}
