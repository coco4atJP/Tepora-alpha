import type React from "react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { CharacterConfig, ProfessionalConfig } from "../types";
import { getApiBase, getAuthHeaders } from "../utils/api";

// ============================================================================
// Types
// ============================================================================

export interface ModelConfig {
	path: string;
	port: number;
	n_ctx: number;
	n_gpu_layers: number;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	repeat_penalty?: number;
	logprobs?: boolean;
}

export interface Config {
	app: {
		max_input_length: number;
		graph_recursion_limit: number;
		tool_execution_timeout: number;
		tool_approval_timeout: number;
		web_fetch_max_chars: number;
		dangerous_patterns: string[];
		language: string;
		nsfw_enabled: boolean;
		setup_completed?: boolean;
		mcp_config_path: string;
	};
	llm_manager: {
		process_terminate_timeout: number;
		health_check_timeout: number;
		health_check_interval: number;
		tokenizer_model_key: string;
		cache_size: number;
	};
	chat_history: {
		max_tokens: number;
		default_limit: number;
	};
	em_llm: {
		surprise_gamma: number;
		min_event_size: number;
		max_event_size: number;
		total_retrieved_events: number;
		repr_topk: number;
		use_boundary_refinement: boolean;
	};
	models_gguf: Record<string, ModelConfig>;
	// Refactored Agent Config
	characters: Record<string, CharacterConfig>;
	professionals: Record<string, ProfessionalConfig>;
	active_agent_profile: string;

	tools: {
		google_search_api_key?: string;
		google_search_engine_id?: string;
	};

	privacy: {
		allow_web_search: boolean;
		redact_pii: boolean;
	};
}

export interface SettingsContextValue {
	config: Config | null;
	originalConfig: Config | null;
	loading: boolean;
	error: string | null;
	hasChanges: boolean;
	saving: boolean;
	// Actions
	fetchConfig: () => Promise<void>;
	updateApp: <K extends keyof Config["app"]>(
		field: K,
		value: Config["app"][K],
	) => void;
	updateLlmManager: <K extends keyof Config["llm_manager"]>(
		field: K,
		value: Config["llm_manager"][K],
	) => void;
	updateChatHistory: <K extends keyof Config["chat_history"]>(
		field: K,
		value: Config["chat_history"][K],
	) => void;
	updateEmLlm: <K extends keyof Config["em_llm"]>(
		field: K,
		value: Config["em_llm"][K],
	) => void;
	updateModel: (
		modelKey: keyof Config["models_gguf"],
		modelConfig: ModelConfig,
	) => void;

	// Tools Actions
	updateTools: <K extends keyof Config["tools"]>(
		field: K,
		value: Config["tools"][K],
	) => void;

	// Privacy Actions
	updatePrivacy: <K extends keyof Config["privacy"]>(
		field: K,
		value: Config["privacy"][K],
	) => void;

	// Character Actions
	updateCharacter: (key: string, config: CharacterConfig) => void;
	addCharacter: (key: string) => void;

	deleteCharacter: (key: string) => void;

	// Professional Actions
	updateProfessional: (key: string, config: ProfessionalConfig) => void;
	addProfessional: (key: string) => void;
	deleteProfessional: (key: string) => void;

	setActiveAgent: (key: string) => void;
	saveConfig: (override?: Config) => Promise<boolean>;
	resetConfig: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const SettingsContext = createContext<SettingsContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface SettingsProviderProps {
	children: ReactNode;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({
	children,
}) => {
	const [config, setConfig] = useState<Config | null>(null);
	const [originalConfig, setOriginalConfig] = useState<Config | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const hasChanges = useMemo(() => {
		if (!config || !originalConfig) return false;
		return JSON.stringify(config) !== JSON.stringify(originalConfig);
	}, [config, originalConfig]);

	const fetchConfig = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const response = await fetch(`${getApiBase()}/api/config`, {
				headers: { ...getAuthHeaders() },
			});
			if (!response.ok) throw new Error("Failed to fetch configuration");
			const data = await response.json();

			// Backward compatibility: Map legacy model keys to new 'text_model' key
			if (data.models_gguf && !data.models_gguf.text_model) {
				const modelsGguf = data.models_gguf as Record<string, unknown>;
				const legacyChar = modelsGguf.character_model as
					| ModelConfig
					| undefined;
				const legacyExec = modelsGguf.executor_model as ModelConfig | undefined;

				if (legacyChar) {
					data.models_gguf.text_model = legacyChar;
				} else if (legacyExec) {
					data.models_gguf.text_model = legacyExec;
				}

				// Ensure embedding_model exists if legacy embedding key is present (though key name is same)
				if (!data.models_gguf.embedding_model && modelsGguf.embedding_model) {
					data.models_gguf.embedding_model =
						modelsGguf.embedding_model as ModelConfig;
				}
			}

			setConfig(data);
			setOriginalConfig(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "An error occurred");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchConfig();
	}, [fetchConfig]);

	// Update functions
	const updateApp = useCallback(
		<K extends keyof Config["app"]>(field: K, value: Config["app"][K]) => {
			setConfig((prev) =>
				prev ? { ...prev, app: { ...prev.app, [field]: value } } : prev,
			);
		},
		[],
	);

	const updateLlmManager = useCallback(
		<K extends keyof Config["llm_manager"]>(
			field: K,
			value: Config["llm_manager"][K],
		) => {
			setConfig((prev) =>
				prev
					? { ...prev, llm_manager: { ...prev.llm_manager, [field]: value } }
					: prev,
			);
		},
		[],
	);

	const updateChatHistory = useCallback(
		<K extends keyof Config["chat_history"]>(
			field: K,
			value: Config["chat_history"][K],
		) => {
			setConfig((prev) =>
				prev
					? {
							...prev,
							chat_history: { ...prev.chat_history, [field]: value },
						}
					: prev,
			);
		},
		[],
	);

	const updateEmLlm = useCallback(
		<K extends keyof Config["em_llm"]>(
			field: K,
			value: Config["em_llm"][K],
		) => {
			setConfig((prev) =>
				prev ? { ...prev, em_llm: { ...prev.em_llm, [field]: value } } : prev,
			);
		},
		[],
	);

	const updateModel = useCallback(
		(modelKey: keyof Config["models_gguf"], modelConfig: ModelConfig) => {
			setConfig((prev) =>
				prev
					? {
							...prev,
							models_gguf: { ...prev.models_gguf, [modelKey]: modelConfig },
						}
					: prev,
			);
		},
		[],
	);

	const updateTools = useCallback(
		<K extends keyof Config["tools"]>(field: K, value: Config["tools"][K]) => {
			setConfig((prev) =>
				prev ? { ...prev, tools: { ...prev.tools, [field]: value } } : prev,
			);
		},
		[],
	);

	const updatePrivacy = useCallback(
		<K extends keyof Config["privacy"]>(
			field: K,
			value: Config["privacy"][K],
		) => {
			setConfig((prev) =>
				prev ? { ...prev, privacy: { ...prev.privacy, [field]: value } } : prev,
			);
		},
		[],
	);

	// Character Management
	const updateCharacter = useCallback(
		(key: string, charConfig: CharacterConfig) => {
			setConfig((prev) =>
				prev
					? {
							...prev,
							characters: { ...prev.characters, [key]: charConfig },
						}
					: prev,
			);
		},
		[],
	);

	const addCharacter = useCallback((key: string) => {
		const defaultChar: CharacterConfig = {
			name: key, // Default name to key
			description: "",
			system_prompt: "You are a helpful assistant.",
		};
		setConfig((prev) =>
			prev
				? {
						...prev,
						characters: { ...prev.characters, [key]: defaultChar },
					}
				: prev,
		);
	}, []);

	const deleteCharacter = useCallback((key: string) => {
		setConfig((prev) => {
			if (!prev) return prev;
			if (prev.active_agent_profile === key) return prev; // Can't delete active
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { [key]: _, ...rest } = prev.characters;
			return { ...prev, characters: rest };
		});
	}, []);

	// Professional Management
	const updateProfessional = useCallback(
		(key: string, profConfig: ProfessionalConfig) => {
			setConfig((prev) =>
				prev
					? {
							...prev,
							professionals: { ...prev.professionals, [key]: profConfig },
						}
					: prev,
			);
		},
		[],
	);

	const addProfessional = useCallback((key: string) => {
		const defaultProf: ProfessionalConfig = {
			name: key,
			description: "",
			system_prompt: "You are a helpful professional assistant.",
			tools: [],
		};
		setConfig((prev) =>
			prev
				? {
						...prev,
						professionals: { ...prev.professionals, [key]: defaultProf },
					}
				: prev,
		);
	}, []);

	const deleteProfessional = useCallback((key: string) => {
		setConfig((prev) => {
			if (!prev) return prev;
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { [key]: _, ...rest } = prev.professionals;
			return { ...prev, professionals: rest };
		});
	}, []);

	const setActiveAgent = useCallback((key: string) => {
		setConfig((prev) => (prev ? { ...prev, active_agent_profile: key } : prev));
	}, []);

	const saveConfig = useCallback(
		async (override?: Config): Promise<boolean> => {
			const configToSave = override || config;
			if (!configToSave) return false;
			try {
				setSaving(true);
				const response = await fetch(`${getApiBase()}/api/config`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...getAuthHeaders(),
					},
					body: JSON.stringify(configToSave),
				});
				if (!response.ok) throw new Error("Failed to save configuration");

				// Update local state if override was used, to ensure consistency
				if (override) {
					setConfig(override);
				}

				setOriginalConfig(configToSave);
				return true;
			} catch (err) {
				console.error("Failed to save config:", err);
				return false;
			} finally {
				setSaving(false);
			}
		},
		[config],
	);

	const resetConfig = useCallback(() => {
		setConfig(originalConfig);
	}, [originalConfig]);

	const value = useMemo<SettingsContextValue>(
		() => ({
			config,
			loading,
			error,
			hasChanges,
			saving,
			fetchConfig,
			updateApp,
			updateLlmManager,
			updateChatHistory,
			updateEmLlm,
			updateModel,
			updateTools,
			updatePrivacy,
			updateCharacter,
			addCharacter,
			deleteCharacter,

			updateProfessional,
			addProfessional,
			deleteProfessional,
			setActiveAgent,
			saveConfig,
			resetConfig,
			originalConfig,
		}),
		[
			config,
			originalConfig,
			loading,
			error,
			hasChanges,
			saving,
			fetchConfig,
			updateApp,
			updateLlmManager,
			updateChatHistory,
			updateEmLlm,
			updateModel,
			updateTools,
			updatePrivacy,
			updateCharacter,
			addCharacter,
			deleteCharacter,

			updateProfessional,
			addProfessional,
			deleteProfessional,
			setActiveAgent,
			saveConfig,
			resetConfig,
		],
	);

	return (
		<SettingsContext.Provider value={value}>
			{children}
		</SettingsContext.Provider>
	);
};
