import { create } from "zustand";
import type { ChatMode } from "../../shared/contracts";
import type { V2TransportConnectionSnapshot } from "../../shared/lib/transportAdapter";

export interface WorkspaceActivityItem {
	id: string;
	status: "pending" | "processing" | "done" | "error";
	label: string;
	agentName?: string;
}

export interface WorkspaceToolConfirmation {
	requestId: string;
	toolName: string;
	description?: string;
	riskLevel: "low" | "medium" | "high" | "critical";
	scopeLabel: string;
	argsPreview: string;
	expiryOptions: number[];
}

interface WorkspaceState {
	selectedSessionId: string | null;
	activeMode: ChatMode;
	draft: string;
	thinkingBudget: number;
	connection: V2TransportConnectionSnapshot;
	statusMessage: string | null;
	activity: WorkspaceActivityItem[];
	searchResults: Array<{
		title: string;
		url: string;
		snippet: string;
	}>;
	pendingToolConfirmation: WorkspaceToolConfirmation | null;
}

interface WorkspaceActions {
	setSelectedSessionId: (sessionId: string | null) => void;
	setActiveMode: (mode: ChatMode) => void;
	setDraft: (draft: string) => void;
	setThinkingBudget: (value: number) => void;
	setConnection: (snapshot: V2TransportConnectionSnapshot) => void;
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
	clearToolConfirmation: () => void;
	resetComposer: () => void;
}

const idleConnection: V2TransportConnectionSnapshot = {
	status: "idle",
	mode: "websocket",
	reconnectAttempts: 0,
	lastError: null,
};

function clampThinkingBudget(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.max(0, Math.min(3, Math.round(value)));
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>(
	(set) => ({
		selectedSessionId: null,
		activeMode: "chat",
		draft: "",
		thinkingBudget: 0,
		connection: idleConnection,
		statusMessage: null,
		activity: [],
		searchResults: [],
		pendingToolConfirmation: null,
		setSelectedSessionId: (selectedSessionId) => {
			set({ selectedSessionId });
		},
		setActiveMode: (activeMode) => {
			set({ activeMode });
		},
		setDraft: (draft) => {
			set({ draft });
		},
		setThinkingBudget: (thinkingBudget) => {
			set({ thinkingBudget: clampThinkingBudget(thinkingBudget) });
		},
		setConnection: (connection) => {
			set({ connection });
		},
		setPanelState: (patch) => {
			set(patch);
		},
		clearToolConfirmation: () => {
			set({ pendingToolConfirmation: null });
		},
		resetComposer: () => {
			set({
				draft: "",
				thinkingBudget: 0,
			});
		},
	}),
);
