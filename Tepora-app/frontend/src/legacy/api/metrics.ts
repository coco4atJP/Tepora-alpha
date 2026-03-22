import { apiClient } from "../../utils/api-client";
import { ENDPOINTS } from "../../utils/endpoints";

export type AgentEventType =
	| "node_started"
	| "node_completed"
	| "prompt_generated"
	| "tool_call"
	| "queue_saturated"
	| "error";

export interface AgentEvent {
	id: string;
	session_id: string;
	node_name: string;
	event_type: AgentEventType;
	metadata: Record<string, unknown>;
	created_at: string;
}

export interface MetricsResponse {
	events: AgentEvent[];
}

export interface SessionBusyMetric {
	session_id: string;
	count: number;
}

export interface RuntimeMetricsSnapshot {
	dispatch_total: number;
	session_busy_total: number;
	too_many_sessions_total: number;
	internal_error_total: number;
	session_busy_top: SessionBusyMetric[];
}

export const metricsApi = {
	getMetrics: (sessionId: string) =>
		apiClient.get<MetricsResponse>(ENDPOINTS.SESSIONS.METRICS(sessionId)),
	getRuntimeMetrics: () =>
		apiClient.get<RuntimeMetricsSnapshot>(ENDPOINTS.METRICS.RUNTIME),
};

