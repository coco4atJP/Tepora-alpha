import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useServerConfig } from "../hooks/useServerConfig";
import type {
	CharacterConfig,
	CustomAgentConfig,
} from "../types";
import { apiClient } from "../utils/api-client";

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
	// Custom Agents (GPTs/Gems-style)
	custom_agents?: Record<string, CustomAgentConfig>;
	active_agent_profile: string;

	tools: {
		google_search_api_key?: string;
		google_search_engine_id?: string;
		search_provider?: "google" | "duckduckgo";
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

	// Custom Agent Actions
	updateCustomAgent: (id: string, agent: CustomAgentConfig) => void;
	addCustomAgent: (agent: CustomAgentConfig) => void;
	deleteCustomAgent: (id: string) => void;

	setActiveAgent: (key: string) => void;
	saveConfig: (override?: Config) => Promise<boolean>;
	resetConfig: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const SettingsContext = createContext<SettingsContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

function normalizeConfig(data: Config): Config {
	if (!data.models_gguf) {
		return data;
	}

	const modelsGguf = { ...data.models_gguf } as Record<string, unknown>;
	const legacyCharacter = modelsGguf.character_model as ModelConfig | undefined;
	const legacyProfessional = modelsGguf.professional as ModelConfig | undefined;
	const legacyTextSource = legacyCharacter ?? legacyProfessional;
	const hasTextModel = "text_model" in modelsGguf;

	if (legacyTextSource && !hasTextModel) {
		modelsGguf.text_model = legacyTextSource;
	}

	if (legacyCharacter || legacyProfessional) {
		delete modelsGguf.character_model;
		delete modelsGguf.professional;
	}

	return {
		...data,
		models_gguf: modelsGguf as Config["models_gguf"],
	};
}

interface SettingsProviderProps {
	children: ReactNode;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({
	children,
}) => {
	const queryClient = useQueryClient();
	const {
		data: serverConfig,
		isLoading: isConfigLoading,
		isFetching: isConfigFetching,
		error: serverError,
		refetch: refetchConfig,
	} = useServerConfig();
	const [config, setConfig] = useState<Config | null>(null);
	const [originalConfig, setOriginalConfig] = useState<Config | null>(null);
	const [saving, setSaving] = useState(false);

	const hasChanges = useMemo(() => {
		if (!config || !originalConfig) return false;
		return JSON.stringify(config) !== JSON.stringify(originalConfig);
	}, [config, originalConfig]);

	const error = useMemo(() => {
		if (!serverError) return null;
		return serverError instanceof Error
			? serverError.message
			: "An error occurred";
	}, [serverError]);

	const loading = isConfigLoading || (!config && isConfigFetching);

	const fetchConfig = useCallback(async () => {
		await refetchConfig();
	}, [refetchConfig]);

	const normalizedServerConfig = useMemo(() => {
		if (!serverConfig) return null;
		return normalizeConfig(serverConfig);
	}, [serverConfig]);

	useEffect(() => {
		if (!normalizedServerConfig) return;
		if (!config || !originalConfig || !hasChanges) {
			setConfig(normalizedServerConfig);
			setOriginalConfig(normalizedServerConfig);
		}
	}, [normalizedServerConfig, config, originalConfig, hasChanges]);

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

	// Custom Agent Management
	const updateCustomAgent = useCallback(
		(id: string, agent: CustomAgentConfig) => {
			setConfig((prev) =>
				prev
					? {
							...prev,
							custom_agents: { ...prev.custom_agents, [id]: agent },
						}
					: prev,
			);
		},
		[],
	);

	const addCustomAgent = useCallback((agent: CustomAgentConfig) => {
		setConfig((prev) =>
			prev
				? {
						...prev,
						custom_agents: { ...prev.custom_agents, [agent.id]: agent },
					}
				: prev,
		);
	}, []);

	const deleteCustomAgent = useCallback((id: string) => {
		setConfig((prev) => {
			if (!prev || !prev.custom_agents) return prev;
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { [id]: _, ...rest } = prev.custom_agents;
			return { ...prev, custom_agents: rest };
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
				await apiClient.post("api/config", configToSave);

				// Update local state if override was used, to ensure consistency
				if (override) {
					setConfig(override);
				}

				setOriginalConfig(configToSave);
				// Keep react-query cache in sync so consumers (e.g. App language sync) update immediately.
				queryClient.setQueryData(["config"], configToSave);
				return true;
			} catch (err) {
				console.error("Failed to save config:", err);
				return false;
			} finally {
				setSaving(false);
			}
		},
		[config, queryClient],
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

			updateCustomAgent,
			addCustomAgent,
			deleteCustomAgent,

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

			updateCustomAgent,
			addCustomAgent,
			deleteCustomAgent,

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
