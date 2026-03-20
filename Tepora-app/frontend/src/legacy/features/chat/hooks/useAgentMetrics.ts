import { useCallback, useState } from "react";
import {
	AgentEvent,
	metricsApi,
	RuntimeMetricsSnapshot,
} from "../../../api/metrics";

export function useAgentMetrics(sessionId: string | null) {
	const [events, setEvents] = useState<AgentEvent[]>([]);
	const [runtime, setRuntime] = useState<RuntimeMetricsSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	const fetchMetrics = useCallback(async () => {
		if (!sessionId) {
			setEvents([]);
			setRuntime(null);
			return;
		}

		setLoading(true);
		setError(null);
		try {
			const [sessionMetrics, runtimeMetrics] = await Promise.all([
				metricsApi.getMetrics(sessionId),
				metricsApi.getRuntimeMetrics(),
			]);
			setEvents(sessionMetrics.events || []);
			setRuntime(runtimeMetrics);
		} catch (err: unknown) {
			setError(err instanceof Error ? err : new Error(String(err)));
		} finally {
			setLoading(false);
		}
	}, [sessionId]);

	return {
		events,
		runtime,
		loading,
		error,
		fetchMetrics,
	};
}
