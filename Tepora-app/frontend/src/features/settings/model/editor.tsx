import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { SetupModel, V2Config } from "../../../shared/contracts";
import {
	useSaveV2ConfigMutation,
	useSetActiveSetupModelMutation,
	useV2ConfigQuery,
	useV2SetupModelsQuery,
} from "./queries";

type SettingsRecord = Record<string, unknown>;

type EditorStatus = "loading" | "ready" | "saving" | "error";

interface SettingsEditorState {
	baseline: SettingsRecord | null;
	draft: SettingsRecord | null;
	dirtyFields: string[];
	status: EditorStatus;
	errorMessage: string | null;
}

type SettingsEditorAction =
	| { type: "HYDRATE"; config: SettingsRecord }
	| { type: "FIELD_CHANGED"; fieldId: string; value: unknown }
	| { type: "SAVE_STARTED" }
	| { type: "SAVE_SUCCEEDED" }
	| { type: "SAVE_FAILED"; message: string }
	| { type: "RESET" };

export interface SettingsEditorContextValue {
	state: EditorStatus;
	errorMessage: string | null;
	hasUnsavedChanges: boolean;
	isModelUpdating: boolean;
	draft: SettingsRecord | null;
	textModels: SetupModel[];
	embeddingModels: SetupModel[];
	activeTextModelId: string | null;
	activeEmbeddingModelId: string | null;
	isSaving: boolean;
	readString: (path: string, fallback?: string) => string;
	readNumber: (path: string, fallback?: number) => number;
	readBoolean: (path: string, fallback?: boolean) => boolean;
	readStringList: (path: string, fallback?: string[]) => string[];
	updateField: (path: string, value: unknown) => void;
	save: () => Promise<void>;
	reset: () => void;
	activateModel: (modelId: string, role: "text" | "embedding") => Promise<void>;
}

const SettingsEditorContext = createContext<SettingsEditorContextValue | null>(null);

export function SettingsEditorProvider({
	children,
}: {
	children: ReactNode;
}) {
	const { i18n } = useTranslation();
	const configQuery = useV2ConfigQuery();
	const saveMutation = useSaveV2ConfigMutation();
	const modelsQuery = useV2SetupModelsQuery();
	const setActiveModelMutation = useSetActiveSetupModelMutation();
	const [state, dispatch] = useReducer(
		settingsEditorReducer,
		undefined,
		createInitialSettingsEditorState,
	);

	useEffect(() => {
		if (!configQuery.data || state.dirtyFields.length > 0) {
			return;
		}

		dispatch({
			type: "HYDRATE",
			config: normalizeConfigForEditor(configQuery.data),
		});
	}, [configQuery.data, state.dirtyFields.length]);

	const modelList = modelsQuery.data?.models ?? [];
	const textModels = modelList.filter((model) => (model.role ?? "text") !== "embedding");
	const embeddingModels = modelList.filter((model) => model.role === "embedding");
	const activeTextModelId =
		textModels.find((model) => Boolean(model.is_active))?.id ?? null;
	const activeEmbeddingModelId =
		embeddingModels.find((model) => Boolean(model.is_active))?.id ?? null;

	const value = useMemo<SettingsEditorContextValue>(() => {
		const draft = state.draft;

		return {
			state:
				state.status === "saving"
					? "saving"
					: configQuery.isLoading && !draft
						? "loading"
						: configQuery.error
							? "error"
							: state.status,
			errorMessage:
				state.errorMessage ??
				(configQuery.error instanceof Error ? configQuery.error.message : null),
			hasUnsavedChanges: state.dirtyFields.length > 0,
			isModelUpdating: setActiveModelMutation.isPending,
			draft,
			textModels,
			embeddingModels,
			activeTextModelId,
			activeEmbeddingModelId,
			isSaving: saveMutation.isPending,
			readString: (path, fallback = "") => {
				const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
				return typeof valueAtPath === "string" ? valueAtPath : fallback;
			},
			readNumber: (path, fallback = 0) => {
				const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
				return typeof valueAtPath === "number" ? valueAtPath : fallback;
			},
			readBoolean: (path, fallback = false) => {
				const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
				return typeof valueAtPath === "boolean" ? valueAtPath : fallback;
			},
			readStringList: (path, fallback = []) => {
				const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
				return Array.isArray(valueAtPath)
					? valueAtPath.filter((item): item is string => typeof item === "string")
					: fallback;
			},
			updateField: (path, fieldValue) => {
				dispatch({
					type: "FIELD_CHANGED",
					fieldId: path,
					value: fieldValue,
				});
			},
			save: async () => {
				if (!state.draft || state.dirtyFields.length === 0) {
					return;
				}

				dispatch({ type: "SAVE_STARTED" });
				try {
					const patch = buildConfigPatch(state.draft, state.dirtyFields);
					await saveMutation.mutateAsync(patch);
					const nextLanguage = readNestedValue(state.draft, "app.language");
					if (typeof nextLanguage === "string" && nextLanguage.length > 0) {
						void i18n.changeLanguage(nextLanguage);
					}
					dispatch({ type: "SAVE_SUCCEEDED" });
				} catch (error) {
					dispatch({
						type: "SAVE_FAILED",
						message:
							error instanceof Error ? error.message : "Failed to save settings",
					});
				}
			},
			reset: () => {
				dispatch({ type: "RESET" });
			},
			activateModel: async (modelId, role) => {
				try {
					await setActiveModelMutation.mutateAsync({
						model_id: modelId,
						role,
					});
				} catch (error) {
					dispatch({
						type: "SAVE_FAILED",
						message:
							error instanceof Error ? error.message : "Failed to update model",
					});
				}
			},
		};
	}, [
		activeEmbeddingModelId,
		activeTextModelId,
		configQuery.error,
		configQuery.isLoading,
		i18n,
		saveMutation,
		setActiveModelMutation,
		state,
		textModels,
		embeddingModels,
	]);

	return (
		<SettingsEditorContext.Provider value={value}>
			{children}
		</SettingsEditorContext.Provider>
	);
}

export function useSettingsEditor() {
	const context = useContext(SettingsEditorContext);
	if (!context) {
		throw new Error("useSettingsEditor must be used within SettingsEditorProvider");
	}
	return context;
}

function createInitialSettingsEditorState(): SettingsEditorState {
	return {
		baseline: null,
		draft: null,
		dirtyFields: [],
		status: "loading",
		errorMessage: null,
	};
}

function settingsEditorReducer(
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
			) as SettingsRecord;
			const baselineValue = readNestedValue(state.baseline, action.fieldId);
			const nextDirtyFields = areValuesEqual(baselineValue, action.value)
				? state.dirtyFields.filter((fieldId) => fieldId !== action.fieldId)
				: Array.from(new Set([...state.dirtyFields, action.fieldId]));

			return {
				...state,
				draft: nextDraft,
				dirtyFields: nextDirtyFields,
				status: "ready",
				errorMessage: null,
			};
		}
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
		case "RESET":
			return {
				...state,
				draft: state.baseline,
				dirtyFields: [],
				status: "ready",
				errorMessage: null,
			};
		default:
			return state;
	}
}

function normalizeConfigForEditor(config: V2Config): SettingsRecord {
	const characters = readNestedValue(config, "characters");
	const characterEntries = isRecord(characters) ? Object.keys(characters) : [];
	const defaultActiveCharacter = characterEntries[0] ?? "bunny_girl";

	return deepMerge(DEFAULT_EDITOR_CONFIG, {
		...config,
		active_character:
			typeof config.active_character === "string" && config.active_character.length > 0
				? config.active_character
				: typeof config.active_character === "string" &&
				  config.active_character.length > 0
				? config.active_character
				: defaultActiveCharacter,
	}) as SettingsRecord;
}

function deepMerge(target: unknown, source: unknown): unknown {
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

function buildConfigPatch(
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

function setNestedValue<T>(target: T, path: string, value: unknown): T {
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

function areValuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
