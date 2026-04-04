import type {
	ApprovalDecision,
	ChatMode,
	SearchMode,
	ToolConfirmationRequest,
} from "../../../shared/contracts";
import type { V2TransportConnectionStatus } from "../../../shared/lib/transportAdapter";

export interface ChatSessionListItemViewModel {
	id: string;
	title: string;
	preview: string | null;
	updatedAt: string;
	messageCount: number;
	isSelected: boolean;
}

export interface ChatMessageViewModel {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	thinking: string | null;
	createdAt: string;
	status: "streaming" | "complete" | "error" | "stopped";
	mode?: ChatMode;
	agentName?: string;
	nodeId?: string;
}

export interface ChatActivityItemViewModel {
	id: string;
	status: "pending" | "processing" | "done" | "error";
	label: string;
	agentName?: string;
}

export interface ChatComposerAttachmentViewModel {
	id: string;
	name: string;
	type: string;
	status: "attached" | "uploading" | "error";
	content?: string;
}

export interface ChatToolConfirmationViewModel {
	requestId: string;
	toolName: string;
	description?: string;
	riskLevel: ToolConfirmationRequest["riskLevel"];
	scopeLabel: string;
	argsPreview: string;
	expiryOptions: number[];
}

export interface ChatScreenViewProps {
	shellState: "loading" | "ready" | "error";
	connectionState: V2TransportConnectionStatus;
	activeMode: ChatMode;
	draft: string;
	sessions: ChatSessionListItemViewModel[];
	selectedSessionId: string | null;
	messages: ChatMessageViewModel[];
	activity: ChatActivityItemViewModel[];
	statusMessage: string | null;
	toolConfirmation: ChatToolConfirmationViewModel | null;
	composer: {
		attachments: ChatComposerAttachmentViewModel[];
		thinkingBudget: number;
		searchMode: SearchMode;
		canSend: boolean;
		canStop: boolean;
		canRegenerate: boolean;
		isSending: boolean;
		canAttachImages: boolean;
	};
	errorMessage: string | null;
	onDraftChange: (draft: string) => void;
	onModeChange: (mode: ChatMode) => void;
	onSearchModeChange: (mode: SearchMode) => void;
	onThinkingBudgetChange: (value: number) => void;
	onSend: () => Promise<void>;
	onStop: () => void;
	onRegenerate: () => Promise<void>;
	onSelectSession: (sessionId: string) => void;
	onCreateSession: () => Promise<void>;
	onRetryConnection: () => Promise<void>;
	onToolDecision: (
		decision: ApprovalDecision,
		ttlSeconds?: number,
	) => Promise<void>;
	onAddAttachment?: () => void;
	onRemoveAttachment: (attachmentId: string) => void;
}
