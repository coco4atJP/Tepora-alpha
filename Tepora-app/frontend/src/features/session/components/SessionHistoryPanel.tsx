/**
 * SessionHistoryPanel - Wrapper component that connects SessionHistory to hooks
 */

import type React from "react";
import { useSessions } from "../../../hooks/useSessions";
import { useSessionStore, useWebSocketStore } from "../../../stores";
import { SessionHistory } from "./SessionHistory";

interface SessionHistoryPanelProps {
	onSessionSelect?: () => void;
}

export const SessionHistoryPanel: React.FC<SessionHistoryPanelProps> = ({ onSessionSelect }) => {
	const { sessions, loading, createSession, deleteSession, renameSession } = useSessions();

	// Get currentSessionId from Stores
	const currentSessionId = useSessionStore((state) => state.currentSessionId);
	const setSession = useWebSocketStore((state) => state.setSession);

	const handleSelectSession = (sessionId: string) => {
		setSession(sessionId);
		if (onSessionSelect) {
			onSessionSelect();
		}
	};

	const handleCreateSession = async () => {
		const session = await createSession();
		if (session) {
			setSession(session.id);
		}
	};

	const handleDeleteSession = async (sessionId: string) => {
		// Check if this is the last session before deletion
		// Note: sessions list comes from prop/hook, likely updated via query invalidation but here we check current state
		const isLastSession = sessions.length === 1 && sessions[0].id === sessionId;

		const wasDeleted = await deleteSession(sessionId);

		if (wasDeleted) {
			if (isLastSession) {
				// If we deleted the last session, create a new one immediately
				const session = await createSession();
				if (session) {
					setSession(session.id);
				}
			} else if (sessionId === currentSessionId) {
				// If we deleted the currently active session, switch to another one
				// We find the first one that isn't the deleted one.
				const nextSession = sessions.find((s) => s.id !== sessionId);
				if (nextSession) {
					setSession(nextSession.id);
				}
			}
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
