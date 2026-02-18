import { Brain, Clock } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
import {
	CollapsibleSection,
	FormGroup,
	FormInput,
	FormSwitch,
	SettingsSection,
} from "../SettingsComponents";

const MemorySettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, originalConfig, updateEmLlm, updateChatHistory } = useSettings();

	if (!config) return null;

	// Default values to prevent crashes if config is missing sections
	const defaultEmConfig = {
		surprise_gamma: 0.1,
		min_event_size: 3,
		max_event_size: 5,
		total_retrieved_events: 10,
		repr_topk: 3,
		use_boundary_refinement: true,
	};
	const defaultHistoryConfig = {
		max_tokens: 8192,
		default_limit: 50,
	};

	const emConfig = config.em_llm || defaultEmConfig;
	const historyConfig = config.chat_history || defaultHistoryConfig;
	const originalEmConfig = originalConfig?.em_llm;
	const originalHistoryConfig = originalConfig?.chat_history;

	const isEmDirty = (field: keyof typeof emConfig) => {
		if (!originalEmConfig) return false;
		return emConfig[field] !== originalEmConfig[field];
	};

	const isHistoryDirty = (field: keyof typeof historyConfig) => {
		if (!originalHistoryConfig) return false;
		return historyConfig[field] !== originalHistoryConfig[field];
	};

	return (
		<div className="space-y-6">
			<SettingsSection title={t("settings.sections.chat_history.title")} icon={<Clock size={18} />}>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
						<FormGroup
							label={t("settings.memory.surprise_gamma.label")}
							tooltip={t("settings.memory.surprise_gamma.description")}
							isDirty={isEmDirty("surprise_gamma")}
						>
							<FormInput
								type="number"
								value={emConfig.surprise_gamma}
								onChange={(v) => updateEmLlm("surprise_gamma", v as number)}
								min={0}
								max={1}
								step={0.05}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.min_event_size.label")}
							tooltip={t("settings.memory.min_event_size.description")}
							isDirty={isEmDirty("min_event_size")}
						>
							<FormInput
								type="number"
								value={emConfig.min_event_size}
								onChange={(v) => updateEmLlm("min_event_size", v as number)}
								min={1}
							/>
						</FormGroup>
						<FormGroup
							label={t("settings.memory.max_event_size.label")}
							tooltip={t("settings.memory.max_event_size.description")}
							isDirty={isEmDirty("max_event_size")}
						>
							<FormInput
								type="number"
								value={emConfig.max_event_size}
								onChange={(v) => updateEmLlm("max_event_size", v as number)}
								min={1}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.memory.retrieved_events.label")}
							tooltip={t("settings.memory.retrieved_events.description")}
							isDirty={isEmDirty("total_retrieved_events")}
						>
							<FormInput
								type="number"
								value={emConfig.total_retrieved_events}
								onChange={(v) => updateEmLlm("total_retrieved_events", v as number)}
								min={1}
								max={50}
							/>
						</FormGroup>
						<FormGroup
							label={t("settings.memory.repr_topk.label")}
							tooltip={t("settings.memory.repr_topk.description")}
							isDirty={isEmDirty("repr_topk")}
						>
							<FormInput
								type="number"
								value={emConfig.repr_topk}
								onChange={(v) => updateEmLlm("repr_topk", v as number)}
								min={1}
								max={50}
							/>
						</FormGroup>

						<div className="flex items-center h-full pt-4">
							<FormGroup
								label={t("settings.memory.boundary_refinement.label")}
								tooltip={t("settings.memory.boundary_refinement.description")}
								isDirty={isEmDirty("use_boundary_refinement")}
							>
								<div className="flex items-center gap-3">
									<FormSwitch
										checked={emConfig.use_boundary_refinement}
										onChange={(v) => updateEmLlm("use_boundary_refinement", v)}
									/>
									<span className="text-sm text-gray-400">
										{emConfig.use_boundary_refinement ? t("common.enabled") : t("common.disabled")}
									</span>
								</div>
							</FormGroup>
						</div>
					</div>
				</CollapsibleSection>
			</SettingsSection>
		</div>
	);
};

export default MemorySettings;
