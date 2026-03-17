import { useWorkspaceStore } from "../../../app/model/workspaceStore";
import { v2TransportAdapter } from "../../../shared/lib/transportAdapter";
import type { AgentPanelViewProps } from "../view/props";

export function useAgentPanelModel(): AgentPanelViewProps {
	const activeMode = useWorkspaceStore((state) => state.activeMode);
	const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
	const thinkingBudget = useWorkspaceStore((state) => state.thinkingBudget);
	const connection = useWorkspaceStore((state) => state.connection);
	const activity = useWorkspaceStore((state) => state.activity);
	const statusMessage = useWorkspaceStore((state) => state.statusMessage);
	const toolConfirmation = useWorkspaceStore(
		(state) => state.pendingToolConfirmation,
	);
	const clearToolConfirmation = useWorkspaceStore(
		(state) => state.clearToolConfirmation,
	);

	const recentActivity = activity
		.slice(-3)
		.map((item) => `${item.status}: ${item.label}`)
		.join("\n");

	return {
		state:
			connection.status === "connecting" || connection.status === "reconnecting"
				? "loading"
				: connection.lastError
					? "error"
					: selectedSessionId
						? "ready"
						: "idle",
		sections: [
			{
				id: "connection",
				title: "Connection",
				body: [
					`Status: ${connection.status}`,
					`Transport: ${connection.mode}`,
					statusMessage ? `Message: ${statusMessage}` : null,
				]
					.filter(Boolean)
					.join("\n"),
			},
			{
				id: "mode",
				title: "Runtime",
				body: [
					`Mode: ${activeMode}`,
					`Thinking budget: ${thinkingBudget}`,
					selectedSessionId ? `Session: ${selectedSessionId}` : "Session: none",
				].join("\n"),
			},
			{
				id: "activity",
				title: "Recent Activity",
				body: recentActivity || "No activity yet.",
			},
		],
		activeContext: [
			selectedSessionId
				? {
						id: `session:${selectedSessionId}`,
						label: "Active session",
						kind: "memory" as const,
				  }
				: null,
			activeMode === "agent"
				? { id: "mode:agent", label: "Agent mode", kind: "agent" as const }
				: activeMode === "search"
					? { id: "mode:search", label: "Search mode", kind: "rag" as const }
					: { id: "mode:chat", label: "Chat mode", kind: "memory" as const },
			toolConfirmation
				? {
						id: `tool:${toolConfirmation.requestId}`,
						label: toolConfirmation.toolName,
						kind: "tool" as const,
				  }
				: null,
		].filter((item): item is NonNullable<typeof item> => item !== null),
		toolConfirmation,
		errorMessage: connection.lastError,
		onToolDecision: async (decision, ttlSeconds) => {
			if (!toolConfirmation) {
				return;
			}

			v2TransportAdapter.send({
				type: "tool_confirmation_response",
				requestId: toolConfirmation.requestId,
				decision,
				ttlSeconds,
			});
			clearToolConfirmation();
		},
	};
}
