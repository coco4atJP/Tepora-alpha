import { useState, useCallback } from "react";
import { AgentEvent, metricsApi } from "../../../api/metrics";

export function useAgentMetrics(sessionId: string | null) {
    const [events, setEvents] = useState<AgentEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const fetchMetrics = useCallback(async () => {
        if (!sessionId) {
            setEvents([]);
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const res = await metricsApi.getMetrics(sessionId);
            setEvents(res.events || []);
        } catch (err: unknown) {
            setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            setLoading(false);
        }
    }, [sessionId]);

    return {
        events,
        loading,
        error,
        fetchMetrics,
    };
}
