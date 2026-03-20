import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "../../../app/model/workspaceStore";
import { v2TransportAdapter } from "../../../shared/lib/transportAdapter";
import { useV2ConfigQuery } from "../../settings/model/queries";
import type { AgentPanelViewProps } from "../view/props";

function stringifyList(items: string[]): string {
	return items.length > 0 ? items.join("\n") : "None";
}

function readConfigNumber(
	source: Record<string, unknown> | undefined,
	path: string[],
	fallback: number,
): number {
	const value = path.reduce<unknown>((current, key) => {
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return undefined;
		}
		return (current as Record<string, unknown>)[key];
	}, source);

	return typeof value === "number" ? value : fallback;
}

function readConfigBoolean(
	source: Record<string, unknown> | undefined,
	path: string[],
	fallback: boolean,
): boolean {
	const value = path.reduce<unknown>((current, key) => {
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return undefined;
		}
		return (current as Record<string, unknown>)[key];
	}, source);

	return typeof value === "boolean" ? value : fallback;
}

export function useAgentPanelModel(): AgentPanelViewProps {
	const { t } = useTranslation();
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
	const configQuery = useV2ConfigQuery();
	const configObject = configQuery.data as Record<string, unknown> | undefined;

	const characters = useMemo(() => {
		if (!configQuery.data?.characters || typeof configQuery.data.characters !== "object") {
			return [];
		}

		return Object.entries(
			configQuery.data.characters as Record<string, Record<string, unknown>>,
		).map(([id, value]) => ({
			id,
			name: String(value.name ?? id),
		}));
	}, [configQuery.data?.characters]);

	const customAgents = useMemo(() => {
		if (!configQuery.data?.custom_agents || typeof configQuery.data.custom_agents !== "object") {
			return [];
		}

		return Object.entries(
			configQuery.data.custom_agents as Record<string, Record<string, unknown>>,
		).map(([id, value]) => ({
			id,
			name: String(value.name ?? id),
			enabled: value.enabled !== false,
			priority:
				typeof value.priority === "number" ? value.priority : Number(value.priority ?? 0),
		}));
	}, [configQuery.data?.custom_agents]);

	const activeCharacter =
		characters.find((character) => character.id === configQuery.data?.active_agent_profile) ??
		characters[0] ??
		null;

	const recentActivity = activity
		.slice(-5)
		.map((item) => `${item.status}: ${item.label}`)
		.join("\n");

	const modeDescriptor = (() => {
		if (activeMode === "search") {
			return {
				title: t("v2.agent.searchTitle", "RAG Search"),
				subtitle: t("v2.agent.searchSubtitle", "Retrieval and evidence view"),
				sections: [
					{
						id: "search-runtime",
						title: t("v2.agent.retrieval", "Retrieval"),
						body: [
							`${t("v2.agent.searchResults", "Vector results")}: ${readConfigNumber(configObject, ["rag", "search_default_limit"], 5)}`,
							`${t("v2.agent.textResults", "Text results")}: ${readConfigNumber(configObject, ["rag", "text_search_default_limit"], 10)}`,
							`${t("v2.agent.rerank", "Embedding rerank")}: ${readConfigBoolean(configObject, ["search", "embedding_rerank"], false) ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}`,
						].join("\n"),
					},
					{
						id: "search-context",
						title: t("v2.agent.contextSources", "Context Sources"),
						body: [
							activeCharacter
								? `${t("v2.agent.character", "Character")}: ${activeCharacter.name}`
								: null,
							selectedSessionId
								? `${t("v2.agent.session", "Session")}: ${selectedSessionId}`
								: `${t("v2.agent.session", "Session")}: ${t("v2.agent.none", "None")}`,
							`${t("v2.agent.webSearch", "Web search")}: ${readConfigBoolean(configObject, ["privacy", "allow_web_search"], false) ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}`,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
			};
		}

		if (activeMode === "agent") {
			return {
				title: t("v2.agent.agentTitle", "Agent Status"),
				subtitle: t("v2.agent.agentSubtitle", "Planner and executor overview"),
				sections: [
					{
						id: "agent-runtime",
						title: t("v2.agent.runtime", "Runtime"),
						body: [
							`${t("v2.agent.connection", "Connection")}: ${connection.status}`,
							`${t("v2.agent.transport", "Transport")}: ${connection.mode}`,
							`${t("v2.agent.thinkingBudget", "Deliberation level")}: ${thinkingBudget}`,
						].join("\n"),
					},
					{
						id: "agent-list",
						title: t("v2.agent.executors", "Executors"),
						body:
							customAgents.length > 0
								? customAgents
										.sort((left, right) => right.priority - left.priority)
										.map(
											(agent) =>
												`${agent.enabled ? "●" : "○"} ${agent.name} (${t("v2.agent.priority", "priority")} ${agent.priority})`,
										)
										.join("\n")
								: t("v2.agent.noExecutors", "No custom executors configured."),
					},
					{
						id: "agent-activity",
						title: t("v2.agent.recentActivity", "Recent Activity"),
						body: recentActivity || t("v2.agent.noActivity", "No activity yet."),
					},
				],
			};
		}

		return {
			title: t("v2.agent.chatTitle", "Chat Overview"),
			subtitle: t("v2.agent.chatSubtitle", "Current persona and session context"),
			sections: [
				{
					id: "chat-persona",
					title: t("v2.agent.characters", "Characters"),
					body:
						characters.length > 0
							? stringifyList(
									characters.map((character) =>
										character.id === activeCharacter?.id
											? `● ${character.name}`
											: `○ ${character.name}`,
									),
							  )
							: t("v2.agent.noCharacters", "No characters configured."),
				},
				{
					id: "chat-session",
					title: t("v2.agent.sessionContext", "Session Context"),
					body: [
						selectedSessionId
							? `${t("v2.agent.session", "Session")}: ${selectedSessionId}`
							: `${t("v2.agent.session", "Session")}: ${t("v2.agent.none", "None")}`,
						statusMessage
							? `${t("v2.agent.status", "Status")}: ${statusMessage}`
							: `${t("v2.agent.status", "Status")}: ${t("v2.agent.ready", "Ready")}`,
					].join("\n"),
				},
			],
		};
	})();

	return {
		state:
			connection.status === "connecting" || connection.status === "reconnecting"
				? "loading"
				: connection.lastError
					? "error"
					: selectedSessionId
						? "ready"
						: "idle",
		title: modeDescriptor.title,
		subtitle: modeDescriptor.subtitle,
		sections: [
			...modeDescriptor.sections,
			{
				id: "connection",
				title: t("v2.agent.connectionDetail", "Connection Detail"),
				body: [
					`${t("v2.agent.connection", "Connection")}: ${connection.status}`,
					`${t("v2.agent.transport", "Transport")}: ${connection.mode}`,
					statusMessage ? `${t("v2.agent.status", "Status")}: ${statusMessage}` : null,
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		activeContext: [
			selectedSessionId
				? {
						id: `session:${selectedSessionId}`,
						label: t("v2.agent.activeSession", "Active session"),
						kind: "memory" as const,
				  }
				: null,
			activeMode === "agent"
				? { id: "mode:agent", label: t("v2.mode.agent", "Agent"), kind: "agent" as const }
				: activeMode === "search"
					? { id: "mode:search", label: t("v2.mode.search", "Search"), kind: "rag" as const }
					: { id: "mode:chat", label: t("v2.mode.chat", "Chat"), kind: "memory" as const },
			activeCharacter
				? {
						id: `character:${activeCharacter.id}`,
						label: activeCharacter.name,
						kind: "memory" as const,
				  }
				: null,
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
