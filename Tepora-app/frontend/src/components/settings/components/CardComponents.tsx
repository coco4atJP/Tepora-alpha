// Card Components
// Model and Agent card components for settings pages

import { Check, Cpu, Users } from "lucide-react";
import type React from "react";
import { FormGroup, FormInput, FormList } from "./FormComponents";

// ============================================================================
// ModelCard
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

export interface ModelCardProps {
    name: string;
    config: ModelConfig;
    onChange: (c: ModelConfig) => void;
    isEmbedding?: boolean;
}

export const ModelCard: React.FC<ModelCardProps> = ({
    name,
    config,
    onChange,
    isEmbedding,
}) => {
    const update = <K extends keyof ModelConfig>(f: K, v: ModelConfig[K]) =>
        onChange({ ...config, [f]: v });

    return (
        <div className="settings-model-card">
            <div className="settings-model-card__header">
                <Cpu size={18} className="text-purple-400" />
                <h3 className="settings-model-card__title">{name}</h3>
            </div>
            <div className="settings-model-card__grid">
                <FormGroup label="Path">
                    <FormInput
                        value={config.path}
                        onChange={(v) => update("path", v as string)}
                        placeholder="models/*.gguf"
                        className="font-mono text-xs"
                    />
                </FormGroup>
                <FormGroup label="Port">
                    <FormInput
                        type="number"
                        value={config.port}
                        onChange={(v) => update("port", v as number)}
                    />
                </FormGroup>
                <FormGroup label="Context">
                    <FormInput
                        type="number"
                        value={config.n_ctx}
                        onChange={(v) => update("n_ctx", v as number)}
                        step={512}
                    />
                </FormGroup>
                <FormGroup label="GPU Layers">
                    <FormInput
                        type="number"
                        value={config.n_gpu_layers}
                        onChange={(v) => update("n_gpu_layers", v as number)}
                        min={-1}
                    />
                </FormGroup>

                {!isEmbedding && (
                    <>
                        <FormGroup label="Temp">
                            <FormInput
                                type="number"
                                value={config.temperature ?? 0.7}
                                onChange={(v) => update("temperature", v as number)}
                                step={0.1}
                            />
                        </FormGroup>
                        <FormGroup label="Top P">
                            <FormInput
                                type="number"
                                value={config.top_p ?? 0.9}
                                onChange={(v) => update("top_p", v as number)}
                                step={0.05}
                            />
                        </FormGroup>
                    </>
                )}
            </div>
        </div>
    );
};

// ============================================================================
// AgentCard
// ============================================================================

export interface AgentProfile {
    label: string;
    description: string;
    persona: {
        key?: string;
        prompt?: string;
    };
    tool_policy: {
        allow: string[];
        deny: string[];
    };
}

export interface AgentCardProps {
    id: string;
    profile: AgentProfile;
    onChange: (p: AgentProfile) => void;
    isActive: boolean;
    onSetActive: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
    id,
    profile,
    onChange,
    isActive,
    onSetActive,
}) => {
    const updateField = <K extends keyof AgentProfile>(
        field: K,
        value: AgentProfile[K],
    ) => {
        onChange({ ...profile, [field]: value });
    };

    const updatePersona = (field: "key" | "prompt", value: string) => {
        onChange({ ...profile, persona: { ...profile.persona, [field]: value } });
    };

    return (
        <div
            className={`settings-agent-card ${isActive ? "settings-agent-card--active" : ""}`}
        >
            <div className="settings-agent-card__header">
                <div className="flex items-center gap-2 flex-1">
                    <Users size={18} className="text-gold-400" />
                    <h3 className="settings-agent-card__title">{profile.label || id}</h3>
                </div>
                <button
                    type="button"
                    onClick={onSetActive}
                    className={`settings-agent-card__active-btn ${isActive ? "settings-agent-card__active-btn--active" : ""}`}
                    title={isActive ? "Currently Active" : "Set as Active"}
                >
                    {isActive && <Check size={14} />}
                    {isActive ? "Active" : "Set Active"}
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <FormGroup label="Label">
                    <FormInput
                        value={profile.label}
                        onChange={(v) => updateField("label", v as string)}
                        placeholder="Agent Name"
                    />
                </FormGroup>
                <FormGroup label="Description">
                    <FormInput
                        value={profile.description}
                        onChange={(v) => updateField("description", v as string)}
                        placeholder="Short description"
                    />
                </FormGroup>
            </div>

            <FormGroup
                label="Persona"
                description="Define the agent's personality and role."
            >
                <div className="space-y-3">
                    <div className="grid grid-cols-[120px_1fr] gap-4 items-center">
                        <span className="text-sm text-gray-400">Preset Key</span>
                        <FormInput
                            value={profile.persona.key || ""}
                            onChange={(v) => updatePersona("key", v as string)}
                            placeholder="e.g. default (Optional)"
                            className="font-mono text-sm"
                        />
                    </div>
                    <div>
                        <span className="text-sm text-gray-400 mb-1 block">
                            Custom Prompt (Override)
                        </span>
                        <textarea
                            value={profile.persona.prompt || ""}
                            onChange={(e) => updatePersona("prompt", e.target.value)}
                            className="settings-input settings-input--textarea w-full font-sans leading-relaxed text-sm p-3 bg-black/20 rounded border border-white/10"
                            rows={3}
                            placeholder="You are a helpful AI assistant..."
                        />
                    </div>
                </div>
            </FormGroup>

            <div className="mt-4 pt-4 border-t border-white/5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FormGroup label="Allowed Tools" description='Use "*" for all.'>
                        <FormList
                            items={profile.tool_policy.allow}
                            onChange={(items) =>
                                onChange({
                                    ...profile,
                                    tool_policy: { ...profile.tool_policy, allow: items },
                                })
                            }
                            placeholder="Tool name..."
                        />
                    </FormGroup>
                    <FormGroup label="Denied Tools">
                        <FormList
                            items={profile.tool_policy.deny}
                            onChange={(items) =>
                                onChange({
                                    ...profile,
                                    tool_policy: { ...profile.tool_policy, deny: items },
                                })
                            }
                            placeholder="Tool name..."
                        />
                    </FormGroup>
                </div>
            </div>
        </div>
    );
};
