import type { ChatScreenViewProps } from "../view/props";
import type { ComposerAttachmentRecord } from "./chatComposerTypes";
import { useChatAttachmentActions } from "./useChatAttachmentActions";
import { useChatSessionActions } from "./useChatSessionActions";

interface UseChatComposerActionsParams {
	selectedSessionId: string | null;
	setSelectedSessionId: (sessionId: string | null) => void;
	activeMode: import("../../../shared/contracts").ChatMode;
	draft: string;
	searchMode: import("../../../shared/contracts").SearchMode;
	thinkingBudget: number;
	connection: import("../../../shared/lib/transportAdapter").V2TransportConnectionSnapshot;
	composerAttachments: ComposerAttachmentRecord[];
	setComposerAttachments: import("react").Dispatch<
		import("react").SetStateAction<ComposerAttachmentRecord[]>
	>;
	sharedToolConfirmation: ChatScreenViewProps["toolConfirmation"];
	clearToolConfirmation: () => void;
	resetComposer: () => void;
	sendToMachine: (event: import("./chatMachine").ChatFlowEvent) => void;
	dispatchPipeline: import("react").Dispatch<
		import("./messagePipeline").ChatPipelineAction
	>;
	setActionError: import("react").Dispatch<
		import("react").SetStateAction<string | null>
	>;
	createSession: (title?: string | null) => Promise<import("../../../shared/contracts").Session>;
}

export function useChatComposerActions({
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
}: UseChatComposerActionsParams) {
	const sessionActions = useChatSessionActions({
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
	});
	const attachmentActions = useChatAttachmentActions({
		setComposerAttachments,
		setActionError,
	});

	return {
		...sessionActions,
		...attachmentActions,
	};
}
