/**
 * Session API hooks
 * Handles session CRUD operations via REST API
 */

import { useState, useCallback, useEffect } from 'react';
import { getApiBase, getAuthHeaders } from '../utils/api';

export interface Session {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    message_count?: number;
    preview?: string;
}

interface UseSessionsReturn {
    sessions: Session[];
    loading: boolean;
    error: string | null;
    fetchSessions: () => Promise<void>;
    createSession: (title?: string) => Promise<Session | null>;
    deleteSession: (id: string) => Promise<boolean>;
    renameSession: (id: string, title: string) => Promise<boolean>;
}

export const useSessions = (): UseSessionsReturn => {
    const [sessions, setSessions] = useState<Session[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchSessions = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${getApiBase()}/api/sessions`, {
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error('Failed to fetch sessions');
            const data = await res.json();
            setSessions(data.sessions || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, []);

    const createSession = useCallback(async (title?: string): Promise<Session | null> => {
        try {
            const res = await fetch(`${getApiBase()}/api/sessions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders(),
                },
                body: JSON.stringify({ title }),
            });
            if (!res.ok) throw new Error('Failed to create session');
            const data = await res.json();
            if (data.session) {
                setSessions(prev => [data.session, ...prev]);
                return data.session;
            }
            return null;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            return null;
        }
    }, []);

    const deleteSession = useCallback(async (id: string): Promise<boolean> => {
        if (id === 'default') {
            setError('Cannot delete default session');
            return false;
        }
        try {
            const res = await fetch(`${getApiBase()}/api/sessions/${id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error('Failed to delete session');
            setSessions(prev => prev.filter(s => s.id !== id));
            // Note: Caller should handle switching to 'default' if current session was deleted
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            return false;
        }
    }, []);

    const renameSession = useCallback(async (id: string, title: string): Promise<boolean> => {
        try {
            const res = await fetch(`${getApiBase()}/api/sessions/${id}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders(),
                },
                body: JSON.stringify({ title }),
            });
            if (!res.ok) throw new Error('Failed to rename session');
            setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s));
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            return false;
        }
    }, []);

    // Fetch sessions on mount
    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    return {
        sessions,
        loading,
        error,
        fetchSessions,
        createSession,
        deleteSession,
        renameSession,
    };
};
