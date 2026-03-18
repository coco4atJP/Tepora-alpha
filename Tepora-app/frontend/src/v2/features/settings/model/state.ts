import type { V2Config } from "../../../shared/contracts";
import type {
	SettingsScreenViewProps,
	SettingsSectionViewModel,
} from "../view/props";

export const SETTINGS_SECTION_IDS = [
	"general",
	"appearance",
	"agents",
	"models",
	"advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsEditorState {
	baseline: V2Config | null;
	draft: V2Config | null;
	dirtyFields: string[];
	status: SettingsScreenViewProps["state"];
	errorMessage: string | null;
	activeSectionId: SettingsSectionId;
}

export type SettingsEditorAction =
	| { type: "HYDRATE"; config: V2Config }
	| {
			type: "FIELD_CHANGED";
			fieldId: string;
			value: string | number | boolean;
	  }
	| { type: "SECTION_CHANGED"; sectionId: SettingsSectionId }
	| { type: "SAVE_STARTED" }
	| { type: "SAVE_SUCCEEDED" }
	| { type: "SAVE_FAILED"; message: string };

export function createInitialSettingsEditorState(): SettingsEditorState {
	return {
		baseline: null,
		draft: null,
		dirtyFields: [],
		status: "loading",
		errorMessage: null,
		activeSectionId: "general",
	};
}

export function normalizeConfigForEditor(config: V2Config): V2Config {
	const redesign = isRecord(config.features?.redesign)
		? config.features?.redesign
		: {};

	return {
		...config,
		app: {
			language: "en",
			setup_completed: false,
			max_input_length: 4000,
			nsfw_enabled: false,
			tool_execution_timeout: 120_000,
			graph_execution_timeout: 180_000,
			...(config.app ?? {}),
		},
		active_agent_profile: config.active_agent_profile ?? "default",
		tools: {
			search_provider: "duckduckgo",
			...(config.tools ?? {}),
		},
		privacy: {
			allow_web_search: true,
			redact_pii: true,
			...(config.privacy ?? {}),
		},
		thinking: {
			chat_default: false,
			search_default: false,
			...(config.thinking ?? {}),
		},
		features: {
			...(config.features ?? {}),
			redesign: {
				...redesign,
				frontend_logging:
					typeof redesign.frontend_logging === "boolean"
						? redesign.frontend_logging
						: false,
				transport_mode:
					redesign.transport_mode === "ipc" || redesign.transport_mode === "websocket"
						? redesign.transport_mode
						: resolveDefaultTransportMode(),
			},
		},
	};
}

export function buildSettingsSections(
	config: V2Config,
): SettingsSectionViewModel[] {
	return [
		{
			id: "general",
			title: "General",
			description: "Core session and language defaults used across v2 screens.",
			fields: [
				{
					id: "app.language",
					label: "Language",
					description: "UI language for the application.",
					kind: "select",
					value: config.app.language ?? "en",
					options: [
						{ label: "English", value: "en" },
						{ label: "Japanese", value: "ja" },
						{ label: "Spanish", value: "es" },
						{ label: "Chinese", value: "zh" },
					],
				},
				{
					id: "active_agent_profile",
					label: "Active agent profile",
					description: "Profile applied when agent mode is used.",
					kind: "text",
					value: config.active_agent_profile ?? "default",
				},
				{
					id: "app.max_input_length",
					label: "Max input length",
					description: "Upper bound for a single prompt payload.",
					kind: "number",
					value: config.app.max_input_length ?? 4000,
				},
			],
		},
		{
			id: "appearance",
			title: "Appearance",
			description:
				"Presentation defaults that affect how the assistant behaves on screen.",
			fields: [
				{
					id: "thinking.chat_default",
					label: "Thinking in chat mode",
					description: "Enable the thinking budget by default in chat mode.",
					kind: "toggle",
					value: config.thinking?.chat_default ?? false,
				},
				{
					id: "thinking.search_default",
					label: "Thinking in search mode",
					description: "Enable the thinking budget by default in search mode.",
					kind: "toggle",
					value: config.thinking?.search_default ?? false,
				},
				{
					id: "app.nsfw_enabled",
					label: "Mature content",
					description: "Allow responses that include mature content.",
					kind: "toggle",
					value: config.app.nsfw_enabled ?? false,
				},
			],
		},
		{
			id: "agents",
			title: "Agents",
			description:
				"Search, privacy, and agent-facing defaults for runtime flows.",
			fields: [
				{
					id: "tools.search_provider",
					label: "Search provider",
					description: "Provider used when search mode delegates to the backend.",
					kind: "select",
					value: config.tools?.search_provider ?? "duckduckgo",
					options: [
						{ label: "DuckDuckGo", value: "duckduckgo" },
						{ label: "Google", value: "google" },
						{ label: "Brave", value: "brave" },
						{ label: "Bing", value: "bing" },
					],
				},
				{
					id: "privacy.allow_web_search",
					label: "Allow web search",
					description: "Permit backend-driven web search.",
					kind: "toggle",
					value: config.privacy?.allow_web_search ?? true,
				},
				{
					id: "privacy.redact_pii",
					label: "Redact PII",
					description: "Mask detected sensitive data before sending it to the backend.",
					kind: "toggle",
					value: config.privacy?.redact_pii ?? true,
				},
			],
		},
		{
			id: "models",
			title: "Models",
			description:
				"Manage installed text and embedding models, remote downloads, and llama.cpp updates.",
			fields: [],
		},
		{
			id: "advanced",
			title: "Advanced",
			description: "Execution and transport settings that affect runtime stability.",
			fields: [
				{
					id: "app.tool_execution_timeout",
					label: "Tool timeout (ms)",
					description: "Maximum runtime for a tool call before it is cancelled.",
					kind: "number",
					value: config.app.tool_execution_timeout ?? 120_000,
				},
				{
					id: "app.graph_execution_timeout",
					label: "Graph timeout (ms)",
					description: "Maximum runtime for agent graph execution.",
					kind: "number",
					value: config.app.graph_execution_timeout ?? 180_000,
				},
				{
					id: "features.redesign.transport_mode",
					label: "Transport mode",
					description: "Select the preferred runtime transport for v2.",
					kind: "select",
					value: readNestedValue(config, "features.redesign.transport_mode") as string,
					options: [
						{ label: "IPC", value: "ipc" },
						{ label: "WebSocket", value: "websocket" },
					],
				},
				{
					id: "features.redesign.frontend_logging",
					label: "Frontend logging",
					description: "Enable verbose logging for the v2 client.",
					kind: "toggle",
					value:
						(readNestedValue(config, "features.redesign.frontend_logging") as boolean) ??
						false,
				},
			],
		},
	];
}

export function buildConfigPatch(
	draft: V2Config,
	dirtyFields: readonly string[],
): Record<string, unknown> {
	let patch: Record<string, unknown> = {};

	for (const fieldId of dirtyFields) {
		patch = setNestedValue(
			patch,
			fieldId,
			readNestedValue(draft, fieldId),
		) as Record<string, unknown>;
	}

	return patch;
}

export function settingsEditorReducer(
	state: SettingsEditorState,
	action: SettingsEditorAction,
): SettingsEditorState {
	switch (action.type) {
		case "HYDRATE":
			return {
				...state,
				baseline: action.config,
				draft: action.config,
				dirtyFields: [],
				status: "ready",
				errorMessage: null,
			};
		case "FIELD_CHANGED": {
			if (!state.draft || !state.baseline) {
				return state;
			}

			const nextDraft = setNestedValue(
				state.draft,
				action.fieldId,
				action.value,
			) as V2Config;
			const baselineValue = readNestedValue(state.baseline, action.fieldId);
			const nextDirtyFields = areValuesEqual(baselineValue, action.value)
				? state.dirtyFields.filter((fieldId) => fieldId !== action.fieldId)
				: Array.from(new Set([...state.dirtyFields, action.fieldId]));

			return {
				...state,
				draft: nextDraft,
				dirtyFields: nextDirtyFields,
				status: state.status === "loading" ? "ready" : state.status,
				errorMessage: null,
			};
		}
		case "SECTION_CHANGED":
			return {
				...state,
				activeSectionId: action.sectionId,
			};
		case "SAVE_STARTED":
			return {
				...state,
				status: "saving",
				errorMessage: null,
			};
		case "SAVE_SUCCEEDED":
			return {
				...state,
				baseline: state.draft,
				dirtyFields: [],
				status: "ready",
				errorMessage: null,
			};
		case "SAVE_FAILED":
			return {
				...state,
				status: "error",
				errorMessage: action.message,
			};
		default:
			return state;
	}
}

function resolveDefaultTransportMode(): "ipc" | "websocket" {
	if (typeof window === "undefined") {
		return "websocket";
	}

	const transportMode = (
		window as Window & {
			__TRANSPORT_MODE__?: "ipc" | "websocket";
		}
	).__TRANSPORT_MODE__;

	return transportMode === "ipc" ? "ipc" : "websocket";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function areValuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function readNestedValue(target: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, segment) => {
		if (!isRecord(current)) {
			return undefined;
		}

		return current[segment];
	}, target);
}

export function setNestedValue<T>(target: T, path: string, value: unknown): T {
	if (!isRecord(target)) {
		return target;
	}

	const keys = path.split(".").filter(Boolean);
	if (keys.length === 0) {
		return target;
	}

	const root: Record<string, unknown> = { ...target };
	let cursor: Record<string, unknown> = root;
	let sourceCursor: Record<string, unknown> = target as Record<string, unknown>;

	for (let index = 0; index < keys.length - 1; index += 1) {
		const key = keys[index];
		if (!key) {
			continue;
		}

		const sourceNext = sourceCursor[key];
		const next = isRecord(sourceNext) ? { ...sourceNext } : {};
		cursor[key] = next;
		cursor = next;
		sourceCursor = isRecord(sourceNext) ? sourceNext : {};
	}

	const lastKey = keys[keys.length - 1];
	if (lastKey) {
		cursor[lastKey] = value;
	}

	return root as T;
}
