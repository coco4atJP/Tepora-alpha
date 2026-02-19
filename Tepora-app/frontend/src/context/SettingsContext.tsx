import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { createContext, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useServerConfig } from "../hooks/useServerConfig";
import type { CharacterConfig, CustomAgentConfig } from "../types";
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
	max_tokens?: number;
	predict_len?: number;
}

export interface Config {
	app: {
		max_input_length: number;
		graph_recursion_limit: number;
		tool_execution_timeout: number;
		tool_approval_timeout: number;
		graph_execution_timeout: number;
		web_fetch_max_chars: number;
		web_fetch_max_bytes: number;
		web_fetch_timeout_secs: number;
		dangerous_patterns: string[];
		language: string;
		nsfw_enabled: boolean;
		setup_completed?: boolean;
		mcp_config_path: string;
	};
	llm_manager: {
		loader?: string;
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
	active_agent_profile: string;

	tools: {
		google_search_api_key?: string;
		google_search_engine_id?: string;
		brave_search_api_key?: string;
		bing_search_api_key?: string;
		search_provider?: "google" | "duckduckgo" | "brave" | "bing";
	};

	privacy: {
		allow_web_search: boolean;
		redact_pii: boolean;
		url_denylist?: string[];
	};

	search?: {
		embedding_rerank?: boolean;
	};

	model_download?: {
		allow_repo_owners?: string[];
		require_allowlist?: boolean;
		warn_on_unlisted?: boolean;
		require_revision?: boolean;
		require_sha256?: boolean;
	};

	server?: {
		host?: string;
		allowed_origins?: string[];
		cors_allowed_origins?: string[];
		ws_allowed_origins?: string[];
	};

	loaders?: Record<string, { base_url?: string }>;

	thinking?: {
		chat_default?: boolean;
		search_default?: boolean;
	};
}

export interface SettingsContextValue {
	config: Config | null;
	originalConfig: Config | null;
	customAgents: Record<string, CustomAgentConfig>;
	loading: boolean;
	error: string | null;
	hasChanges: boolean;
	saving: boolean;
	// Actions
	fetchConfig: () => Promise<void>;
	updateApp: <K extends keyof Config["app"]>(field: K, value: Config["app"][K]) => void;
	updateLlmManager: <K extends keyof Config["llm_manager"]>(
		field: K,
		value: Config["llm_manager"][K],
	) => void;
	updateChatHistory: <K extends keyof Config["chat_history"]>(
		field: K,
		value: Config["chat_history"][K],
	) => void;
	updateEmLlm: <K extends keyof Config["em_llm"]>(field: K, value: Config["em_llm"][K]) => void;
	updateModel: (modelKey: keyof Config["models_gguf"], modelConfig: ModelConfig) => void;

	// Tools Actions
	updateTools: <K extends keyof Config["tools"]>(field: K, value: Config["tools"][K]) => void;

	// Privacy Actions
	updatePrivacy: <K extends keyof Config["privacy"]>(field: K, value: Config["privacy"][K]) => void;

	// Search Actions
	updateSearch: <K extends keyof NonNullable<Config["search"]>>(field: K, value: NonNullable<Config["search"]>[K]) => void;

	// Model Download Actions
	updateModelDownload: <K extends keyof NonNullable<Config["model_download"]>>(field: K, value: NonNullable<Config["model_download"]>[K]) => void;

	// Server Actions
	updateServer: <K extends keyof NonNullable<Config["server"]>>(field: K, value: NonNullable<Config["server"]>[K]) => void;

	// Loaders Actions
	updateLoaderBaseUrl: (loaderName: string, baseUrl: string) => void;

	// Thinking Actions
	updateThinking: <K extends keyof NonNullable<Config["thinking"]>>(field: K, value: NonNullable<Config["thinking"]>[K]) => void;

	// Character Actions
	updateCharacter: (key: string, config: CharacterConfig) => void;
	addCharacter: (key: string) => void;

	deleteCharacter: (key: string) => void;

	// Custom Agent Actions
	updateCustomAgent: (id: string, agent: CustomAgentConfig) => Promise<void>;
	addCustomAgent: (agent: CustomAgentConfig) => Promise<void>;
	deleteCustomAgent: (id: string) => Promise<void>;

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
	const modelsGguf = { ...(data.models_gguf || {}) } as Record<string, unknown>;

	if (!data.models_gguf) {
		// If it was missing, we just return the data with empty models_gguf
		// But we should still ensure other required fields like tools are present if we are doing that below
	}

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
		tools: data.tools || {},
		models_gguf: (modelsGguf as Config["models_gguf"]) || {},
	};
}

interface SettingsProviderProps {
	children: ReactNode;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children }) => {
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
	const [customAgents, setCustomAgents] = useState<Record<string, CustomAgentConfig>>({});
	const [saving, setSaving] = useState(false);

	const hasChanges = useMemo(() => {
		if (!config || !originalConfig) return false;
		return JSON.stringify(config) !== JSON.stringify(originalConfig);
	}, [config, originalConfig]);

	const error = useMemo(() => {
		if (!serverError) return null;
		return serverError instanceof Error ? serverError.message : "An error occurred";
	}, [serverError]);

	const loading = isConfigLoading || (!config && isConfigFetching);

	const fetchCustomAgents = useCallback(async () => {
		try {
			const data = await apiClient.get<{ agents: CustomAgentConfig[] }>("api/custom-agents");
			const agentsMap: Record<string, CustomAgentConfig> = {};
			if (data.agents) {
				for (const agent of data.agents) {
					agentsMap[agent.id] = agent;
				}
			}
			setCustomAgents(agentsMap);
		} catch (e) {
			console.error("Failed to fetch custom agents", e);
		}
	}, []);

	const fetchConfig = useCallback(async () => {
		await Promise.all([refetchConfig(), fetchCustomAgents()]);
	}, [refetchConfig, fetchCustomAgents]);

	const normalizedServerConfig = useMemo(() => {
		if (!serverConfig) return null;
		return normalizeConfig(serverConfig);
	}, [serverConfig]);

	useEffect(() => {
		fetchCustomAgents();
	}, [fetchCustomAgents]);

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
			setConfig((prev) => (prev ? { ...prev, app: { ...prev.app, [field]: value } } : prev));
		},
		[],
	);

	const updateLlmManager = useCallback(
		<K extends keyof Config["llm_manager"]>(field: K, value: Config["llm_manager"][K]) => {
			setConfig((prev) =>
				prev ? { ...prev, llm_manager: { ...prev.llm_manager, [field]: value } } : prev,
			);
		},
		[],
	);

	const updateChatHistory = useCallback(
		<K extends keyof Config["chat_history"]>(field: K, value: Config["chat_history"][K]) => {
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
		<K extends keyof Config["em_llm"]>(field: K, value: Config["em_llm"][K]) => {
			setConfig((prev) => (prev ? { ...prev, em_llm: { ...prev.em_llm, [field]: value } } : prev));
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
			setConfig((prev) => (prev ? { ...prev, tools: { ...prev.tools, [field]: value } } : prev));
		},
		[],
	);

	const updatePrivacy = useCallback(
		<K extends keyof Config["privacy"]>(field: K, value: Config["privacy"][K]) => {
			setConfig((prev) =>
				prev ? { ...prev, privacy: { ...prev.privacy, [field]: value } } : prev,
			);
		},
		[],
	);

	const updateSearch = useCallback(
		<K extends keyof NonNullable<Config["search"]>>(field: K, value: NonNullable<Config["search"]>[K]) => {
			setConfig((prev) =>
				prev ? { ...prev, search: { ...(prev.search || {}), [field]: value } } : prev,
			);
		},
		[],
	);

	const updateModelDownload = useCallback(
		<K extends keyof NonNullable<Config["model_download"]>>(field: K, value: NonNullable<Config["model_download"]>[K]) => {
			setConfig((prev) =>
				prev ? { ...prev, model_download: { ...(prev.model_download || {}), [field]: value } } : prev,
			);
		},
		[],
	);

	const updateServer = useCallback(
		<K extends keyof NonNullable<Config["server"]>>(field: K, value: NonNullable<Config["server"]>[K]) => {
			setConfig((prev) =>
				prev ? { ...prev, server: { ...(prev.server || {}), [field]: value } } : prev,
			);
		},
		[],
	);

	const updateLoaderBaseUrl = useCallback(
		(loaderName: string, baseUrl: string) => {
			setConfig((prev) =>
				prev
					? {
						...prev,
						loaders: {
							...(prev.loaders || {}),
							[loaderName]: {
								...((prev.loaders || {})[loaderName] || {}),
								base_url: baseUrl,
							},
						},
					}
					: prev,
			);
		},
		[],
	);

	const updateThinking = useCallback(
		<K extends keyof NonNullable<Config["thinking"]>>(field: K, value: NonNullable<Config["thinking"]>[K]) => {
			setConfig((prev) =>
				prev ? { ...prev, thinking: { ...(prev.thinking || {}), [field]: value } } : prev,
			);
		},
		[],
	);

	// Character Management
	const updateCharacter = useCallback((key: string, charConfig: CharacterConfig) => {
		setConfig((prev) =>
			prev
				? {
					...prev,
					characters: { ...prev.characters, [key]: charConfig },
				}
				: prev,
		);
	}, []);

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
			const { [key]: _unused, ...rest } = prev.characters;
			return { ...prev, characters: rest };
		});
	}, []);

	// Custom Agent Management
	const updateCustomAgent = useCallback(
		async (id: string, agent: CustomAgentConfig) => {
			try {
				await apiClient.put(`api/custom-agents/${id}`, agent);
				await fetchCustomAgents();
			} catch (e) {
				console.error("Failed to update custom agent", e);
				throw e;
			}
		},
		[fetchCustomAgents],
	);

	const addCustomAgent = useCallback(
		async (agent: CustomAgentConfig) => {
			try {
				await apiClient.post("api/custom-agents", agent);
				await fetchCustomAgents();
			} catch (e) {
				console.error("Failed to add custom agent", e);
				throw e;
			}
		},
		[fetchCustomAgents],
	);

	const deleteCustomAgent = useCallback(
		async (id: string) => {
			try {
				await apiClient.delete(`api/custom-agents/${id}`);
				await fetchCustomAgents();
			} catch (e) {
				console.error("Failed to delete custom agent", e);
				throw e;
			}
		},
		[fetchCustomAgents],
	);

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
			originalConfig,
			customAgents,
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
			updateSearch,
			updateModelDownload,
			updateServer,
			updateLoaderBaseUrl,
			updateThinking,
			updateCharacter,
			addCharacter,
			deleteCharacter,

			updateCustomAgent,
			addCustomAgent,
			deleteCustomAgent,

			setActiveAgent,
			saveConfig,
			resetConfig,
		}),
		[
			config,
			originalConfig,
			customAgents,
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
			updateSearch,
			updateModelDownload,
			updateServer,
			updateLoaderBaseUrl,
			updateThinking,
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

	return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};
