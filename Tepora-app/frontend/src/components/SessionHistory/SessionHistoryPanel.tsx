/**
 * SessionHistoryPanel - Wrapper component that connects SessionHistory to hooks
 */

import React from 'react';
import { SessionHistory } from './SessionHistory';
import { useSessions } from '../../hooks/useSessions';
import { useWebSocketContext } from '../../context/WebSocketContext';

export const SessionHistoryPanel: React.FC = () => {
    const {
        sessions,
        loading,
        createSession,
        deleteSession,
        renameSession,
    } = useSessions();

    // Get currentSessionId from WebSocketContext (single source of truth)
    const { currentSessionId, setCurrentSessionId } = useWebSocketContext();

    const handleSelectSession = (sessionId: string) => {
        setCurrentSessionId(sessionId);
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
            setCurrentSessionId('default');
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

