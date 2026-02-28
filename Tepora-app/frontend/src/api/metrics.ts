import { apiClient } from "../utils/api-client";
import { ENDPOINTS } from "../utils/endpoints";

export type AgentEventType =
    | "node_started"
    | "node_completed"
    | "prompt_generated"
    | "tool_call"
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

export const metricsApi = {
    getMetrics: (sessionId: string) =>
        apiClient.get<MetricsResponse>(ENDPOINTS.SESSIONS.METRICS(sessionId)),
};
