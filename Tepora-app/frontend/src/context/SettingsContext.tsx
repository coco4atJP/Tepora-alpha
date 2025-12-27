import React, { createContext, useState, useCallback, useEffect, useMemo, ReactNode } from 'react';
import { API_BASE, getAuthHeaders } from '../utils/api';
import { CharacterConfig, ProfessionalConfig } from '../types';

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
        dangerous_patterns: string[];
        language: string;
    };
    llm_manager: {
        process_terminate_timeout: number;
        health_check_timeout: number;
        health_check_interval: number;
        tokenizer_model_key: string;
    };
    chat_history: {
        max_tokens: number;
    };
    em_llm: {
        surprise_gamma: number;
        min_event_size: number;
        max_event_size: number;
        total_retrieved_events: number;
        repr_topk: number;
        use_boundary_refinement: boolean;
    };
    models_gguf: {
        character_model: ModelConfig;
        executor_model: ModelConfig;
        embedding_model: ModelConfig;
    };
    // Refactored Agent Config
    characters: Record<string, CharacterConfig>;
    professionals: Record<string, ProfessionalConfig>;
    active_agent_profile: string;
}

export interface SettingsContextValue {
    config: Config | null;
    loading: boolean;
    error: string | null;
    hasChanges: boolean;
    saving: boolean;
    // Actions
    fetchConfig: () => Promise<void>;
    updateApp: (field: keyof Config['app'], value: unknown) => void;
    updateLlmManager: (field: keyof Config['llm_manager'], value: unknown) => void;
    updateChatHistory: (field: keyof Config['chat_history'], value: unknown) => void;
    updateEmLlm: (field: keyof Config['em_llm'], value: unknown) => void;
    updateModel: (modelKey: keyof Config['models_gguf'], modelConfig: ModelConfig) => void;

    // Character Actions
    updateCharacter: (key: string, config: CharacterConfig) => void;
    addCharacter: (key: string) => void;
    deleteCharacter: (key: string) => void;

    setActiveAgent: (key: string) => void;
    saveConfig: () => Promise<boolean>;
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

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children }) => {
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
            const response = await fetch(`${API_BASE}/api/config`, {
                headers: { ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Failed to fetch configuration');
            const data = await response.json();
            setConfig(data);
            setOriginalConfig(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchConfig();
    }, [fetchConfig]);

    // Update functions
    const updateApp = useCallback((field: keyof Config['app'], value: unknown) => {
        setConfig((prev) => prev ? { ...prev, app: { ...prev.app, [field]: value } } : prev);
    }, []);

    const updateLlmManager = useCallback((field: keyof Config['llm_manager'], value: unknown) => {
        setConfig((prev) => prev ? { ...prev, llm_manager: { ...prev.llm_manager, [field]: value } } : prev);
    }, []);

    const updateChatHistory = useCallback((field: keyof Config['chat_history'], value: unknown) => {
        setConfig((prev) => prev ? {
            ...prev,
            chat_history: { ...prev.chat_history, [field]: Number(value) }
        } : prev);
    }, []);

    const updateEmLlm = useCallback((field: keyof Config['em_llm'], value: unknown) => {
        setConfig((prev) => prev ? { ...prev, em_llm: { ...prev.em_llm, [field]: value } } : prev);
    }, []);

    const updateModel = useCallback((modelKey: keyof Config['models_gguf'], modelConfig: ModelConfig) => {
        setConfig((prev) => prev ? {
            ...prev,
            models_gguf: { ...prev.models_gguf, [modelKey]: modelConfig },
        } : prev);
    }, []);

    // Character Management
    const updateCharacter = useCallback((key: string, charConfig: CharacterConfig) => {
        setConfig((prev) => prev ? {
            ...prev,
            characters: { ...prev.characters, [key]: charConfig },
        } : prev);
    }, []);

    const addCharacter = useCallback((key: string) => {
        const defaultChar: CharacterConfig = {
            name: key, // Default name to key
            description: '',
            system_prompt: 'You are a helpful assistant.',
        };
        setConfig((prev) => prev ? {
            ...prev,
            characters: { ...prev.characters, [key]: defaultChar },
        } : prev);
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

    const setActiveAgent = useCallback((key: string) => {
        setConfig((prev) => prev ? { ...prev, active_agent_profile: key } : prev);
    }, []);

    const saveConfig = useCallback(async (): Promise<boolean> => {
        if (!config) return false;
        try {
            setSaving(true);
            const response = await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify(config),
            });
            if (!response.ok) throw new Error('Failed to save configuration');
            setOriginalConfig(config);
            return true;
        } catch (err) {
            console.error('Failed to save config:', err);
            return false;
        } finally {
            setSaving(false);
        }
    }, [config]);

    const resetConfig = useCallback(() => {
        setConfig(originalConfig);
    }, [originalConfig]);

    const value = useMemo<SettingsContextValue>(() => ({
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
        updateCharacter,
        addCharacter,
        deleteCharacter,
        setActiveAgent,
        saveConfig,
        resetConfig,
    }), [
        config, loading, error, hasChanges, saving,
        fetchConfig, updateApp, updateLlmManager, updateChatHistory, updateEmLlm,
        updateModel, updateCharacter, addCharacter, deleteCharacter, setActiveAgent,
        saveConfig, resetConfig,
    ]);

    return (
        <SettingsContext.Provider value={value}>
            {children}
        </SettingsContext.Provider>
    );
};
