/**
 * SessionHistoryPanel - Wrapper component that connects SessionHistory to hooks
 */

import type React from "react";
import { useWebSocketContext } from "../../context/WebSocketContext";
import { useSessions } from "../../hooks/useSessions";
import { SessionHistory } from "./SessionHistory";

interface SessionHistoryPanelProps {
	onSessionSelect?: () => void;
}

export const SessionHistoryPanel: React.FC<SessionHistoryPanelProps> = ({
	onSessionSelect,
}) => {
	const { sessions, loading, createSession, deleteSession, renameSession } =
		useSessions();

	// Get currentSessionId from WebSocketContext (single source of truth)
	const { currentSessionId, setCurrentSessionId } = useWebSocketContext();

	const handleSelectSession = (sessionId: string) => {
		setCurrentSessionId(sessionId);
		if (onSessionSelect) {
			onSessionSelect();
		}
	};

	const handleCreateSession = async () => {
		const session = await createSession();
		if (session) {
			setCurrentSessionId(session.id);
		}
	};

	const handleDeleteSession = async (sessionId: string) => {
		const wasDeleted = await deleteSession(sessionId);
		// If deleted session was the current one, switch to default
		if (wasDeleted && sessionId === currentSessionId) {
			setCurrentSessionId("default");
		}
	};

	return (
		<SessionHistory
			sessions={sessions}
			currentSessionId={currentSessionId}
			onSelectSession={handleSelectSession}
			onCreateSession={handleCreateSession}
			onDeleteSession={handleDeleteSession}
			onRenameSession={renameSession}
			loading={loading}
		/>
	);
};

export default SessionHistoryPanel;
