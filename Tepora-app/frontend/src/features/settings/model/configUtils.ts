import type { V2Config } from "../../../shared/contracts";

export type SettingsRecord = Record<string, unknown>;

const DEFAULT_EDITOR_CONFIG: SettingsRecord = {
	app: {
		language: "en",
		max_input_length: 4000,
		graph_recursion_limit: 50,
		tool_execution_timeout: 300,
		tool_approval_timeout: 300,
		graph_execution_timeout: 180000,
		web_fetch_max_chars: 6000,
		web_fetch_max_bytes: 1000000,
		web_fetch_timeout_secs: 10,
		history_limit: 6,
		entity_extraction_limit: 6,
		episodic_memory_enabled: true,
		mcp_config_path: "",
	},
	active_character: "bunny_girl",
	thinking: {
		chat_default: false,
		search_default: false,
	},
	tools: {
		search_provider: "duckduckgo",
		google_search_api_key: "",
		google_search_engine_id: "",
		brave_search_api_key: "",
		bing_search_api_key: "",
	},
	privacy: {
		allow_web_search: false,
		redact_pii: true,
		isolation_mode: false,
		url_policy_preset: "balanced",
		url_denylist: [],
	},
	quarantine: {
		enabled: false,
		required: false,
		required_transports: ["stdio", "wasm"],
	},
	rag: {
		search_default_limit: 5,
		text_search_default_limit: 10,
		embedding_timeout_ms: 5000,
		chunk_window_default_chars: 1200,
	},
	search: {
		embedding_rerank: false,
	},
	backup: {
		startup_auto_backup_limit: 10,
		enable_restore: true,
		include_chat_history: true,
		include_settings: true,
		include_characters: true,
		include_executors: true,
		encryption: {
			enabled: false,
		},
	},
	llm_manager: {
		loader: "ollama",
		process_terminate_timeout: 5000,
		health_check_timeout: 10000,
		health_check_interval: 1000,
	},
	loaders: {
		ollama: {
			base_url: "http://localhost:11434",
		},
		lmstudio: {
			base_url: "http://localhost:1234",
		},
	},
	permissions: {
		default_ttl_seconds: 86400,
	},
	features: {
		redesign: {
			transport_mode: resolveDefaultTransportMode(),
			frontend_logging: false,
		},
	},
	ui: {
		theme: "tepora",
		font_size: 14,
	},
	notifications: {
		background_task: {
			os_notification: false,
		},
	},
	storage: {
		location: "",
	},
	system: {
		auto_start: false,
		auto_update: true,
	},
	agent_skills: {
		roots: [],
	},
};

export function normalizeConfigForEditor(config: V2Config): SettingsRecord {
	const characters = readNestedValue(config, "characters");
	const characterEntries = isRecord(characters) ? Object.keys(characters) : [];
	const defaultActiveCharacter = characterEntries[0] ?? "bunny_girl";
	const activeCharacter =
		typeof config.active_character === "string" && config.active_character.length > 0
			? config.active_character
			: defaultActiveCharacter;

	return deepMerge(DEFAULT_EDITOR_CONFIG, {
		...config,
		active_character: activeCharacter,
	}) as SettingsRecord;
}

export function deepMerge(target: unknown, source: unknown): unknown {
	if (isRecord(target) && isRecord(source)) {
		const nextTarget: Record<string, unknown> = { ...target };

		for (const [key, value] of Object.entries(source)) {
			nextTarget[key] =
				key in nextTarget ? deepMerge(nextTarget[key], value) : value;
		}

		return nextTarget;
	}

	return source;
}

export function buildConfigPatch(
	draft: SettingsRecord,
	dirtyFields: readonly string[],
): SettingsRecord {
	let patch: SettingsRecord = {};

	for (const fieldId of dirtyFields) {
		patch = setNestedValue(
			patch,
			fieldId,
			readNestedValue(draft, fieldId),
		) as SettingsRecord;
	}

	return patch;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
