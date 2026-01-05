import type React from "react";
import { createContext, type ReactNode, useContext } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import type {
	AgentActivity,
	Attachment,
	ChatMode,
	MemoryStats,
	Message,
	SearchResult,
	ToolConfirmationRequest,
} from "../types";

interface WebSocketContextType {
	isConnected: boolean;
	isProcessing: boolean;
	messages: Message[];
	searchResults: SearchResult[];
	memoryStats: MemoryStats | null;
	activityLog: AgentActivity[];
	sendMessage: (
		content: string,
		mode: ChatMode,
		attachments?: Attachment[],
		skipWebSearch?: boolean,
	) => void;
	clearMessages: () => void;
	stopGeneration: () => void;
	error: string | null;
	clearError: () => void;
	// Tool confirmation (A+C Hybrid)
	pendingToolConfirmation: ToolConfirmationRequest | null;
	handleToolConfirmation: (
		requestId: string,
		approved: boolean,
		remember: boolean,
	) => void;
	// Session management
	currentSessionId: string;
	setCurrentSessionId: (sessionId: string) => void;
	isLoadingHistory: boolean; // UX改善4
}

const WebSocketContext = createContext<WebSocketContextType | undefined>(
	undefined,
);

export const WebSocketProvider: React.FC<{ children: ReactNode }> = ({
	children,
}) => {
	const wsData = useWebSocket();

	return (
		<WebSocketContext.Provider value={wsData}>
			{children}
		</WebSocketContext.Provider>
	);
};

// eslint-disable-next-line react-refresh/only-export-components
export const useWebSocketContext = () => {
	const context = useContext(WebSocketContext);
	if (!context) {
		throw new Error(
			"useWebSocketContext must be used within a WebSocketProvider",
		);
	}
	return context;
};
