import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useServerConfig } from "../hooks/useServerConfig";
import type { AgentSkillsResponse } from "../types";
import type {
	AgentSkillPackage,
	AgentSkillSaveRequest,
	AgentSkillSummary,
	CharacterConfig,
	Config,
	ModelConfig,
	SkillRootInfo,
} from "../types/settings";
import { isDesktop } from "../utils/api";
import { apiClient } from "../utils/api-client";
import { configureLogger } from "../utils/logger";

export interface SettingsStateValue {
	config: Config | null;
	originalConfig: Config | null;
	loading: boolean;
	error: string | null;
	hasChanges: boolean;
	saving: boolean;
}

export interface SettingsConfigActionsValue {
	fetchConfig: () => Promise<void>;
	saveConfig: (override?: Config) => Promise<boolean>;
	resetConfig: () => void;
	updateApp: <K extends keyof Config["app"]>(field: K, value: Config["app"][K]) => void;
	updateLlmManager: <K extends keyof Config["llm_manager"]>(field: K, value: Config["llm_manager"][K]) => void;
	updateChatHistory: <K extends keyof Config["chat_history"]>(field: K, value: Config["chat_history"][K]) => void;
	updateEmLlm: <K extends keyof Config["em_llm"]>(field: K, value: Config["em_llm"][K]) => void;
	updateModel: (modelKey: keyof Config["models_gguf"], modelConfig: ModelConfig) => void;
	updateTools: <K extends keyof Config["tools"]>(field: K, value: Config["tools"][K]) => void;
	updatePrivacy: <K extends keyof Config["privacy"]>(field: K, value: Config["privacy"][K]) => void;
	updateSearch: <K extends keyof NonNullable<Config["search"]>>(field: K, value: NonNullable<Config["search"]>[K]) => void;
	updateModelDownload: <K extends keyof NonNullable<Config["model_download"]>>(field: K, value: NonNullable<Config["model_download"]>[K]) => void;
	updateServer: <K extends keyof NonNullable<Config["server"]>>(field: K, value: NonNullable<Config["server"]>[K]) => void;
	updateLoaderBaseUrl: (loaderName: string, baseUrl: string) => void;
	updateThinking: <K extends keyof NonNullable<Config["thinking"]>>(field: K, value: NonNullable<Config["thinking"]>[K]) => void;
	updateConfigPath: (path: string, value: unknown) => void;
}

export interface AgentSkillsValue {
	agentSkills: Record<string, AgentSkillSummary>;
	skillRoots: SkillRootInfo[];
	fetchAgentSkills: () => Promise<void>;
	getAgentSkill: (id: string) => Promise<AgentSkillPackage>;
	saveAgentSkill: (payload: AgentSkillSaveRequest) => Promise<AgentSkillPackage>;
	deleteAgentSkill: (id: string) => Promise<void>;
}

export interface AgentProfilesValue {
	characters: Record<string, CharacterConfig>;
	activeAgentProfile: string | null;
	updateCharacter: (key: string, config: CharacterConfig) => void;
	addCharacter: (key: string) => void;
	deleteCharacter: (key: string) => void;
	setActiveAgent: (key: string) => void;
}

const SettingsStateContext = createContext<SettingsStateValue | null>(null);
const SettingsConfigActionsContext = createContext<SettingsConfigActionsValue | null>(null);
const AgentSkillsContext = createContext<AgentSkillsValue | null>(null);
const AgentProfilesContext = createContext<AgentProfilesValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setNestedValue<T>(target: T, path: string, value: unknown): T {
	if (!isRecord(target)) return target;

	const keys = path.split(".").filter(Boolean);
	if (keys.length === 0) return target;

	const root: Record<string, unknown> = { ...target };
	let cursor: Record<string, unknown> = root;
	let sourceCursor: Record<string, unknown> = target as Record<string, unknown>;

	for (let i = 0; i < keys.length - 1; i += 1) {
		const key = keys[i];
		if (!key) continue;
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

function normalizeConfig(data: Config): Config {
	const modelsGguf = { ...(data.models_gguf || {}) } as Record<string, unknown>;
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
	const [agentSkills, setAgentSkills] = useState<Record<string, AgentSkillSummary>>({});
	const [skillRoots, setSkillRoots] = useState<SkillRootInfo[]>([]);
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

	const fetchAgentSkills = useCallback(async () => {
		try {
			const data = await apiClient.get<AgentSkillsResponse>("api/agent-skills");
			const nextSkills: Record<string, AgentSkillSummary> = {};
			for (const skill of data.skills || []) {
				nextSkills[skill.id] = skill;
			}
			setAgentSkills(nextSkills);
			setSkillRoots(data.roots || []);
		} catch (fetchError) {
			console.error("Failed to fetch Agent Skills", fetchError);
		}
	}, []);

	const getAgentSkill = useCallback(async (id: string) => {
		return apiClient.get<AgentSkillPackage>(`api/agent-skills/${encodeURIComponent(id)}`);
	}, []);

	const saveAgentSkill = useCallback(
		async (payload: AgentSkillSaveRequest) => {
			const response = await apiClient.post<{ success: boolean; skill: AgentSkillPackage }>(
				"api/agent-skills",
				payload,
			);
			await fetchAgentSkills();
			return response.skill;
		},
		[fetchAgentSkills],
	);

	const deleteAgentSkill = useCallback(
		async (id: string) => {
			await apiClient.delete(`api/agent-skills/${encodeURIComponent(id)}`);
			await fetchAgentSkills();
		},
		[fetchAgentSkills],
	);

	const fetchConfig = useCallback(async () => {
		await Promise.all([refetchConfig(), fetchAgentSkills()]);
	}, [refetchConfig, fetchAgentSkills]);

	const normalizedServerConfig = useMemo(() => {
		if (!serverConfig) return null;
		return normalizeConfig(serverConfig);
	}, [serverConfig]);

	useEffect(() => {
		fetchAgentSkills();
	}, [fetchAgentSkills]);

	useEffect(() => {
		if (!normalizedServerConfig) return;
		configureLogger(!!normalizedServerConfig.features?.redesign?.frontend_logging);

		if (typeof window !== "undefined") {
			const win = window as unknown as { __TRANSPORT_MODE__?: "ipc" | "websocket" };
			const raw = normalizedServerConfig.features?.redesign?.transport_mode;
			const configuredMode = raw === "ipc" || raw === "websocket" ? raw : undefined;
			if (configuredMode) {
				win.__TRANSPORT_MODE__ = configuredMode;
			} else if (!win.__TRANSPORT_MODE__) {
				win.__TRANSPORT_MODE__ = isDesktop() ? "ipc" : "websocket";
			}
		}

		if (!config || !originalConfig || !hasChanges) {
			setConfig(normalizedServerConfig);
			setOriginalConfig(normalizedServerConfig);
		}
	}, [normalizedServerConfig, config, originalConfig, hasChanges]);

	const updateApp = useCallback(<K extends keyof Config["app"]>(field: K, value: Config["app"][K]) => {
		setConfig((prev) => (prev ? { ...prev, app: { ...prev.app, [field]: value } } : prev));
	}, []);

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
				prev ? { ...prev, chat_history: { ...prev.chat_history, [field]: value } } : prev,
			);
		},
		[],
	);

	const updateEmLlm = useCallback(<K extends keyof Config["em_llm"]>(field: K, value: Config["em_llm"][K]) => {
		setConfig((prev) => (prev ? { ...prev, em_llm: { ...prev.em_llm, [field]: value } } : prev));
	}, []);

	const updateModel = useCallback((modelKey: keyof Config["models_gguf"], modelConfig: ModelConfig) => {
		setConfig((prev) =>
			prev ? { ...prev, models_gguf: { ...prev.models_gguf, [modelKey]: modelConfig } } : prev,
		);
	}, []);

	const updateTools = useCallback(<K extends keyof Config["tools"]>(field: K, value: Config["tools"][K]) => {
		setConfig((prev) => (prev ? { ...prev, tools: { ...prev.tools, [field]: value } } : prev));
	}, []);

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
		<K extends keyof NonNullable<Config["model_download"]>>(
			field: K,
			value: NonNullable<Config["model_download"]>[K],
		) => {
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

	const updateLoaderBaseUrl = useCallback((loaderName: string, baseUrl: string) => {
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
	}, []);

	const updateThinking = useCallback(
		<K extends keyof NonNullable<Config["thinking"]>>(field: K, value: NonNullable<Config["thinking"]>[K]) => {
			setConfig((prev) =>
				prev ? { ...prev, thinking: { ...(prev.thinking || {}), [field]: value } } : prev,
			);
		},
		[],
	);

	const updateConfigPath = useCallback((path: string, value: unknown) => {
		setConfig((prev) => (prev ? setNestedValue(prev, path, value) : prev));
	}, []);

	const updateCharacter = useCallback((key: string, charConfig: CharacterConfig) => {
		setConfig((prev) =>
			prev ? { ...prev, characters: { ...prev.characters, [key]: charConfig } } : prev,
		);
	}, []);

	const addCharacter = useCallback((key: string) => {
		const defaultChar: CharacterConfig = {
			name: key,
			description: "",
			system_prompt: "You are a helpful assistant.",
		};
		setConfig((prev) =>
			prev ? { ...prev, characters: { ...prev.characters, [key]: defaultChar } } : prev,
		);
	}, []);

	const deleteCharacter = useCallback((key: string) => {
		setConfig((prev) => {
			if (!prev) return prev;
			if (prev.active_agent_profile === key) return prev;
			const { [key]: _unused, ...rest } = prev.characters;
			return { ...prev, characters: rest };
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
				if (override) {
					setConfig(override);
				}
				setOriginalConfig(configToSave);
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

	const settingsStateValue = useMemo<SettingsStateValue>(
		() => ({
			config,
			originalConfig,
			loading,
			error,
			hasChanges,
			saving,
		}),
		[config, originalConfig, loading, error, hasChanges, saving],
	);

	const settingsConfigActionsValue = useMemo<SettingsConfigActionsValue>(
		() => ({
			fetchConfig,
			saveConfig,
			resetConfig,
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
			updateConfigPath,
		}),
		[
			fetchConfig,
			saveConfig,
			resetConfig,
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
			updateConfigPath,
		],
	);

	const agentSkillsValue = useMemo<AgentSkillsValue>(
		() => ({
			agentSkills,
			skillRoots,
			fetchAgentSkills,
			getAgentSkill,
			saveAgentSkill,
			deleteAgentSkill,
		}),
		[
			agentSkills,
			skillRoots,
			fetchAgentSkills,
			getAgentSkill,
			saveAgentSkill,
			deleteAgentSkill,
		],
	);

	const agentProfilesValue = useMemo<AgentProfilesValue>(
		() => ({
			characters: config?.characters || {},
			activeAgentProfile: config?.active_agent_profile || null,
			updateCharacter,
			addCharacter,
			deleteCharacter,
			setActiveAgent,
		}),
		[
			config?.characters,
			config?.active_agent_profile,
			updateCharacter,
			addCharacter,
			deleteCharacter,
			setActiveAgent,
		],
	);

	return (
		<SettingsStateContext.Provider value={settingsStateValue}>
			<SettingsConfigActionsContext.Provider value={settingsConfigActionsValue}>
				<AgentSkillsContext.Provider value={agentSkillsValue}>
					<AgentProfilesContext.Provider value={agentProfilesValue}>{children}</AgentProfilesContext.Provider>
				</AgentSkillsContext.Provider>
			</SettingsConfigActionsContext.Provider>
		</SettingsStateContext.Provider>
	);
};

function useRequiredContext<T>(context: React.Context<T | null>, hookName: string): T {
	const value = useContext(context);
	if (!value) {
		throw new Error(`${hookName} must be used within a SettingsProvider`);
	}
	return value;
}

export function useSettingsState(): SettingsStateValue {
	return useRequiredContext(SettingsStateContext, "useSettingsState");
}

export function useSettingsConfigActions(): SettingsConfigActionsValue {
	return useRequiredContext(SettingsConfigActionsContext, "useSettingsConfigActions");
}

export function useAgentSkills(): AgentSkillsValue {
	return useRequiredContext(AgentSkillsContext, "useAgentSkills");
}

export function useAgentProfiles(): AgentProfilesValue {
	return useRequiredContext(AgentProfilesContext, "useAgentProfiles");
}

