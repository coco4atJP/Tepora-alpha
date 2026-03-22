import { useMachine } from "@xstate/react";
import { useDeferredValue, useReducer, useState } from "react";
import type { ComposerAttachmentRecord } from "./chatComposerTypes";
import { chatFlowMachine } from "./chatMachine";
import {
	chatPipelineReducer,
	createInitialChatPipelineState,
} from "./messagePipeline";

export function useChatInteractionState(isCreatingSession: boolean) {
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
	const isBusy =
		machineSnapshot.matches("sending") ||
		machineSnapshot.matches("streaming") ||
		machineSnapshot.matches("awaitingToolConfirmation") ||
		isCreatingSession;
	const isStreaming =
		machineSnapshot.matches("sending") || machineSnapshot.matches("streaming");

	return {
		machineSnapshot,
		sendToMachine,
		pipelineState,
		dispatchPipeline,
		composerAttachments,
		setComposerAttachments,
		actionError,
		setActionError,
		deferredMessages,
		isBusy,
		isStreaming,
	};
}
