import type { ApprovalDecision } from "../../../shared/contracts";

export interface AgentContextChipViewModel {
	id: string;
	label: string;
	kind: "agent" | "rag" | "memory" | "tool";
}

export interface AgentPanelSectionViewModel {
	id: string;
	title: string;
	body: string;
}

export interface AgentPanelViewProps {
	state: "idle" | "loading" | "ready" | "error";
	sections: AgentPanelSectionViewModel[];
	activeContext: AgentContextChipViewModel[];
	toolConfirmation: null | {
		requestId: string;
		toolName: string;
		description?: string;
		scopeLabel: string;
		argsPreview: string;
		riskLevel: "low" | "medium" | "high" | "critical";
		expiryOptions: number[];
	};
	errorMessage: string | null;
	onToolDecision: (
		decision: ApprovalDecision,
		ttlSeconds?: number,
	) => Promise<void>;
}
