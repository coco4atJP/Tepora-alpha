import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { ToolConfirmationRequest } from "../../types";

interface ToolConfirmationState {
	pendingToolConfirmation: ToolConfirmationRequest | null;
	approvedTools: Set<string>;
}

interface ToolConfirmationActions {
	setPendingToolConfirmation: (request: ToolConfirmationRequest | null) => void;
	clearPendingToolConfirmation: () => void;
	approveToolForSession: (toolName: string) => void;
	isToolApproved: (toolName: string) => boolean;
	reset: () => void;
}

export type ToolConfirmationStore = ToolConfirmationState & ToolConfirmationActions;

const initialState: ToolConfirmationState = {
	pendingToolConfirmation: null,
	approvedTools: new Set(),
};

export const useToolConfirmationStore = create<ToolConfirmationStore>()(
	devtools(
		(set, get) => ({
			...initialState,
			setPendingToolConfirmation: (request) => {
				set({ pendingToolConfirmation: request }, false, "setPendingToolConfirmation");
			},
			clearPendingToolConfirmation: () => {
				set({ pendingToolConfirmation: null }, false, "clearPendingToolConfirmation");
			},
			approveToolForSession: (toolName) => {
				set(
					(state) => ({
						approvedTools: new Set(state.approvedTools).add(toolName),
					}),
					false,
					"approveToolForSession",
				);
			},
			isToolApproved: (toolName) => get().approvedTools.has(toolName),
			reset: () => {
				set(initialState, false, "resetToolConfirmation");
			},
		}),
		{ name: "tool-confirmation-store" },
	),
);

