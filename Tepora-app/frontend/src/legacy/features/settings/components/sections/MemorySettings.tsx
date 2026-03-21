import { Brain, Clock } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettingsConfigActions, useSettingsState } from "../../../../context/SettingsContext";
import {
	CollapsibleSection,
	FormGroup,
	FormInput,
	FormSwitch,
	SettingsSection,
} from "../SettingsComponents";

const MemorySettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, originalConfig } = useSettingsState();
	const { updateEpisodicMemory, updateChatHistory, updateConfigPath } = useSettingsConfigActions();

	if (!config) return null;

	// Default values to prevent crashes if config is missing sections
	const defaultEmConfig = {
		surprise_gamma: 0.1,
		min_event_size: 3,
		max_event_size: 5,
		total_retrieved_events: 10,
		repr_topk: 3,
		use_boundary_refinement: true,
		decay: {
			lambda_base: 0.1,
			promote_threshold: 0.7,
			demote_threshold: 0.3,
			prune_threshold: 0.05,
		},
	};
	const defaultHistoryConfig = {
		max_tokens: 8192,
		default_limit: 50,
	};

	const episodicConfig = {
		...defaultEmConfig,
		...(config.episodic_memory || {}),
		decay: {
			...defaultEmConfig.decay,
			...(config.episodic_memory?.decay || {}),
		},
	};
	const historyConfig = config.chat_history || defaultHistoryConfig;
	const originalEmConfig = originalConfig?.episodic_memory;
	const originalHistoryConfig = originalConfig?.chat_history;

	const isEpisodicDirty = (field: keyof typeof episodicConfig) => {
		if (!originalEmConfig) return false;
		return episodicConfig[field] !== originalEmConfig[field];
	};

	const isHistoryDirty = (field: keyof typeof historyConfig) => {
		if (!originalHistoryConfig) return false;
		return historyConfig[field] !== originalHistoryConfig[field];
	};

	const isDecayDirty = (field: keyof typeof episodicConfig.decay) => {
		if (!originalEmConfig?.decay) return false;
		return episodicConfig.decay[field] !== originalEmConfig.decay[field];
	};

	return (
		<div className="space-y-6">
			<SettingsSection title={t("settings.sections.chat_history.title")} icon={<Clock size={18} />}>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.memory.max_tokens.label")}
						tooltip={t("settings.memory.max_tokens.description")}
						isDirty={isHistoryDirty("max_tokens")}
					>
						<FormInput
							type="number"
							value={historyConfig.max_tokens}
							onChange={(v) => updateChatHistory("max_tokens", v as number)}
							min={1024}
							step={1024}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.memory.default_limit.label")}
						tooltip={t("settings.memory.default_limit.description")}
						isDirty={isHistoryDirty("default_limit")}
					>
						<FormInput
							type="number"
							value={historyConfig.default_limit}
							onChange={(v) => updateChatHistory("default_limit", v as number)}
							min={1}
							max={200}
							step={10}
						/>
					</FormGroup>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.memory.title")}
				icon={<Brain size={18} />}
				description={t("settings.sections.memory.description")}
			>
				{/* Link to Memory Explorer */}
				<div className="mb-6 p-4 bg-teal-500/10 border border-teal-500/20 rounded-xl flex items-center justify-between">
					<div>
						<h3 className="text-teal-300 font-medium mb-1">
							{t("settings.memory.explorer.title", "Memory Explorer")}
						</h3>
						<p className="text-sm text-teal-400/70">
							{t(
								"settings.memory.explorer.description",
								"View and manage all saved episodic events",
							)}
						</p>
					</div>
					<a
						href="/memory"
						target="_blank"
						className="px-4 py-2 bg-teal-500/20 hover:bg-teal-500/30 text-teal-300 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
						rel="noopener"
					>
						<Brain size={16} />
						{t("settings.memory.explorer.button", "Open Explorer")}
					</a>
				</div>

				<CollapsibleSection
					title={t("settings.memory.episodic_params_title") || "Episodic Memory Parameters"}
					description={
						t("settings.memory.episodic_params_desc") || "Advanced configuration for EM-LLM"
					}
					defaultOpen={true}
				>
					<div className="space-y-4">
						<FormGroup
							label={t("settings.memory.surprise_gamma.label")}
							tooltip={t("settings.memory.surprise_gamma.description")}
							isDirty={isEpisodicDirty("surprise_gamma")}
						>
							<FormInput
								type="number"
								value={episodicConfig.surprise_gamma}
								onChange={(v) => updateEpisodicMemory("surprise_gamma", v as number)}
								min={0}
								max={1}
								step={0.05}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.min_event_size.label")}
							tooltip={t("settings.memory.min_event_size.description")}
							isDirty={isEpisodicDirty("min_event_size")}
						>
							<FormInput
								type="number"
								value={episodicConfig.min_event_size}
								onChange={(v) => updateEpisodicMemory("min_event_size", v as number)}
								min={1}
							/>
						</FormGroup>
						<FormGroup
							label={t("settings.memory.max_event_size.label")}
							tooltip={t("settings.memory.max_event_size.description")}
							isDirty={isEpisodicDirty("max_event_size")}
						>
							<FormInput
								type="number"
								value={episodicConfig.max_event_size}
								onChange={(v) => updateEpisodicMemory("max_event_size", v as number)}
								min={1}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.retrieved_events.label")}
							tooltip={t("settings.memory.retrieved_events.description")}
							isDirty={isEpisodicDirty("total_retrieved_events")}
						>
							<FormInput
								type="number"
								value={episodicConfig.total_retrieved_events}
								onChange={(v) => updateEpisodicMemory("total_retrieved_events", v as number)}
								min={1}
								max={50}
							/>
						</FormGroup>
						<FormGroup
							label={t("settings.memory.repr_topk.label")}
							tooltip={t("settings.memory.repr_topk.description")}
							isDirty={isEpisodicDirty("repr_topk")}
						>
							<FormInput
								type="number"
								value={episodicConfig.repr_topk}
								onChange={(v) => updateEpisodicMemory("repr_topk", v as number)}
								min={1}
								max={50}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.boundary_refinement.label")}
							tooltip={t("settings.memory.boundary_refinement.description")}
							isDirty={isEpisodicDirty("use_boundary_refinement")}
						>
							<div className="flex items-center gap-3">
								<FormSwitch
									checked={episodicConfig.use_boundary_refinement}
									onChange={(v) => updateEpisodicMemory("use_boundary_refinement", v)}
								/>
								<span className="text-sm text-gray-400">
									{episodicConfig.use_boundary_refinement ? t("common.enabled") : t("common.disabled")}
								</span>
							</div>
						</FormGroup>
					</div>
				</CollapsibleSection>

				<CollapsibleSection
					title={t("settings.memory.decay_params_title", "FadeMem Decay Parameters")}
					description={t(
						"settings.memory.decay_params_desc",
						"Adaptive memory decay and ranking behavior",
					)}
					defaultOpen={true}
				>
					<div className="space-y-4">
						<FormGroup
							label={t("settings.memory.decay.lambda_base.label", "Lambda Base")}
							tooltip={t(
								"settings.memory.decay.lambda_base.description",
								"Base forgetting rate used in strength decay.",
							)}
							isDirty={isDecayDirty("lambda_base")}
						>
							<FormInput
								type="number"
								value={episodicConfig.decay.lambda_base}
								onChange={(v) => updateConfigPath("episodic_memory.decay.lambda_base", v)}
								min={0.000001}
								max={5}
								step={0.01}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.decay.promote_threshold.label", "Promote Threshold")}
							tooltip={t(
								"settings.memory.decay.promote_threshold.description",
								"Importance threshold to promote SML to LML.",
							)}
							isDirty={isDecayDirty("promote_threshold")}
						>
							<FormInput
								type="number"
								value={episodicConfig.decay.promote_threshold}
								onChange={(v) => updateConfigPath("episodic_memory.decay.promote_threshold", v)}
								min={0}
								max={1}
								step={0.01}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.decay.demote_threshold.label", "Demote Threshold")}
							tooltip={t(
								"settings.memory.decay.demote_threshold.description",
								"Importance threshold to demote LML to SML.",
							)}
							isDirty={isDecayDirty("demote_threshold")}
						>
							<FormInput
								type="number"
								value={episodicConfig.decay.demote_threshold}
								onChange={(v) => updateConfigPath("episodic_memory.decay.demote_threshold", v)}
								min={0}
								max={1}
								step={0.01}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.decay.prune_threshold.label", "Prune Threshold")}
							tooltip={t(
								"settings.memory.decay.prune_threshold.description",
								"Memories below this strength are removed in decay cycles.",
							)}
							isDirty={isDecayDirty("prune_threshold")}
						>
							<FormInput
								type="number"
								value={episodicConfig.decay.prune_threshold}
								onChange={(v) => updateConfigPath("episodic_memory.decay.prune_threshold", v)}
								min={0}
								max={1}
								step={0.01}
							/>
						</FormGroup>
					</div>
				</CollapsibleSection>
			</SettingsSection>
		</div>
	);
};

export default MemorySettings;
