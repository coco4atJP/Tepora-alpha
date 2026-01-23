// Card Components
// Model and Agent card components for settings pages

import { Check, Cpu, Users } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
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
	const { t } = useTranslation();
	const { originalConfig } = useSettings();
	const originalModelConfig = originalConfig?.models_gguf[name];

	const isDirty = (field: keyof ModelConfig) => {
		if (!originalModelConfig) return false;
		// Special handling for legacy undefined vs default values if needed,
		// but simple equality check is good start.
		return config[field] !== originalModelConfig[field];
	};

	const update = <K extends keyof ModelConfig>(f: K, v: ModelConfig[K]) =>
		onChange({ ...config, [f]: v });

	return (
		<div className="settings-model-card">
			<div className="settings-model-card__header">
				<Cpu size={18} className="text-purple-400" />
				<h3 className="settings-model-card__title">{name}</h3>
			</div>
			<div className="settings-model-card__grid">
				<FormGroup
					label={t("settings.models_settings.configurations.path")}
					isDirty={isDirty("path")}
				>
					<FormInput
						value={config.path}
						onChange={(v) => update("path", v as string)}
						placeholder="models/*.gguf"
						className="font-mono text-xs"
					/>
				</FormGroup>
				<FormGroup
					label={t("settings.models_settings.configurations.port")}
					isDirty={isDirty("port")}
				>
					<FormInput
						type="number"
						value={config.port}
						onChange={(v) => update("port", v as number)}
					/>
				</FormGroup>
				<FormGroup
					label={t("settings.models_settings.configurations.context")}
					isDirty={isDirty("n_ctx")}
				>
					<FormInput
						type="number"
						value={config.n_ctx}
						onChange={(v) => update("n_ctx", v as number)}
						step={512}
					/>
				</FormGroup>
				<FormGroup
					label={t("settings.models_settings.configurations.gpu_layers")}
					isDirty={isDirty("n_gpu_layers")}
				>
					<FormInput
						type="number"
						value={config.n_gpu_layers}
						onChange={(v) => update("n_gpu_layers", v as number)}
						min={-1}
					/>
				</FormGroup>

				{!isEmbedding && (
					<>
						<FormGroup
							label={t("settings.models_settings.configurations.temp")}
							isDirty={isDirty("temperature")}
						>
							<FormInput
								type="number"
								value={config.temperature ?? 0.7}
								onChange={(v) => update("temperature", v as number)}
								step={0.1}
								min={0}
								max={2}
							/>
						</FormGroup>
						<FormGroup
							label={t("settings.models_settings.configurations.top_p")}
							isDirty={isDirty("top_p")}
						>
							<FormInput
								type="number"
								value={config.top_p ?? 0.9}
								onChange={(v) => update("top_p", v as number)}
								step={0.05}
								min={0}
								max={1}
							/>
						</FormGroup>
						<FormGroup
							label={t("settings.models_settings.configurations.top_k")}
							isDirty={isDirty("top_k")}
						>
							<FormInput
								type="number"
								value={config.top_k ?? 40}
								onChange={(v) => update("top_k", v as number)}
								step={1}
								min={1}
								max={100}
							/>
						</FormGroup>
						<FormGroup
							label={t(
								"settings.models_settings.configurations.repeat_penalty",
							)}
							isDirty={isDirty("repeat_penalty")}
						>
							<FormInput
								type="number"
								value={config.repeat_penalty ?? 1.1}
								onChange={(v) => update("repeat_penalty", v as number)}
								step={0.05}
								min={1}
								max={2}
							/>
						</FormGroup>
						{/* Logprobs might be internal/advanced, keeping minimal */}
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
	const { t } = useTranslation();
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
					title={
						isActive
							? t("settings.sections.agents.card.currently_active")
							: t("settings.sections.agents.card.set_active")
					}
				>
					{isActive && <Check size={14} />}
					{isActive
						? t("settings.sections.agents.card.active")
						: t("settings.sections.agents.card.set_active_short")}
				</button>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
				<FormGroup label={t("settings.sections.agents.card.label")}>
					<FormInput
						value={profile.label}
						onChange={(v) => updateField("label", v as string)}
						placeholder={t("settings.sections.agents.card.label_placeholder")}
					/>
				</FormGroup>
				<FormGroup label={t("settings.sections.agents.card.description")}>
					<FormInput
						value={profile.description}
						onChange={(v) => updateField("description", v as string)}
						placeholder={t(
							"settings.sections.agents.card.description_placeholder",
						)}
					/>
				</FormGroup>
			</div>

			<FormGroup
				label={t("settings.sections.agents.card.persona")}
				description={t("settings.sections.agents.card.persona_description")}
			>
				<div className="space-y-3">
					<div className="grid grid-cols-[120px_1fr] gap-4 items-center">
						<span className="text-sm text-gray-400">
							{t("settings.sections.agents.card.preset_key")}
						</span>
						<FormInput
							value={profile.persona.key || ""}
							onChange={(v) => updatePersona("key", v as string)}
							placeholder={t(
								"settings.sections.agents.card.preset_key_placeholder",
							)}
							className="font-mono text-sm"
						/>
					</div>
					<div>
						<span className="text-sm text-gray-400 mb-1 block">
							{t("settings.sections.agents.card.custom_prompt")}
						</span>
						<textarea
							value={profile.persona.prompt || ""}
							onChange={(e) => updatePersona("prompt", e.target.value)}
							className="settings-input settings-input--textarea w-full font-sans leading-relaxed text-sm p-3 bg-black/20 rounded border border-white/10"
							rows={3}
							placeholder={t(
								"settings.sections.agents.card.custom_prompt_placeholder",
							)}
						/>
					</div>
				</div>
			</FormGroup>

			<div className="mt-4 pt-4 border-t border-white/5">
				<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
					<FormGroup
						label={t("settings.sections.agents.card.allowed_tools")}
						description={t(
							"settings.sections.agents.card.allowed_tools_description",
						)}
					>
						<FormList
							items={profile.tool_policy.allow}
							onChange={(items) =>
								onChange({
									...profile,
									tool_policy: { ...profile.tool_policy, allow: items },
								})
							}
							placeholder={t("settings.sections.agents.card.tool_placeholder")}
						/>
					</FormGroup>
					<FormGroup label={t("settings.sections.agents.card.denied_tools")}>
						<FormList
							items={profile.tool_policy.deny}
							onChange={(items) =>
								onChange({
									...profile,
									tool_policy: { ...profile.tool_policy, deny: items },
								})
							}
							placeholder={t("settings.sections.agents.card.tool_placeholder")}
						/>
					</FormGroup>
				</div>
			</div>
		</div>
	);
};
