export interface SessionSidebarItemViewModel {
	id: string;
	title: string;
	preview: string | null;
	updatedAt: string;
	messageCount: number;
	isSelected: boolean;
}

export interface SessionSidebarViewProps {
	state: "loading" | "ready" | "error";
	sessions: SessionSidebarItemViewModel[];
	errorMessage: string | null;
	pendingSessionId: string | null;
	onSelectSession: (sessionId: string) => void;
	onCreateSession: () => Promise<void>;
	onRenameSession: (sessionId: string, title: string) => Promise<void>;
	onDeleteSession: (sessionId: string) => Promise<void>;
}
