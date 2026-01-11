import { Cpu, Server } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../hooks/useSettings";
import {
	CollapsibleSection,
	FormGroup,
	FormInput,
	ModelCard,
	SettingsSection,
} from "../SettingsComponents";

const ModelSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, originalConfig, updateLlmManager, updateModel } =
		useSettings();

	if (!config) return null;

	const llmConfig = config.llm_manager;
	const originalLlmConfig = originalConfig?.llm_manager;
	const modelsConfig = config.models_gguf;

	const isLlmDirty = (field: keyof typeof llmConfig) => {
		if (!originalLlmConfig) return false;
		return llmConfig[field] !== originalLlmConfig[field];
	};

	return (
		<div className="space-y-6">
			{/* Manager Settings */}
			<SettingsSection
				title={
					t("settings.sections.models.manager_title") || "LLM Manager Settings"
				}
				icon={<Server size={18} />}
				description={
					t("settings.sections.models.manager_description") ||
					"Configure how the system manages LLM processes and resources."
				}
			>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<FormGroup
						label={t("settings.fields.cache_size") || "Model Cache Limit"}
						description={
							t("settings.descriptions.cache_size") ||
							"Number of models to keep loaded in memory simultaneously."
						}
						isDirty={isLlmDirty("cache_size")}
					>
						<FormInput
							type="number"
							value={llmConfig.cache_size ?? 1}
							onChange={(v) => updateLlmManager("cache_size", v as number)}
							min={1}
							max={5}
							step={1}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.models_settings.global_manager.tokenizer_model")}
						description={t("settings.fields.tokenizer_model.description") || "Model key used for token counting."}
						isDirty={isLlmDirty("tokenizer_model_key")}
					>
						<FormInput
							value={llmConfig.tokenizer_model_key}
							onChange={(v) =>
								updateLlmManager("tokenizer_model_key", v as string)
							}
						/>
					</FormGroup>
				</div>

				<CollapsibleSection
					title={t("settings.sections.models.advanced_title") || "Advanced Manager Settings"}
					description={t("settings.sections.models.advanced_description") || "Timeouts and health checks"}
				>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						<FormGroup
							label={
								t("settings.fields.process_terminate_timeout.label") ||
								"Terminate Timeout"
							}
							tooltip={t(
								"settings.fields.process_terminate_timeout.description",
							)}
							isDirty={isLlmDirty("process_terminate_timeout")}
						>
							<FormInput
								type="number"
								value={llmConfig.process_terminate_timeout}
								onChange={(v) =>
									updateLlmManager("process_terminate_timeout", v as number)
								}
								min={1}
								max={60}
								step={1}
							/>
						</FormGroup>

						<FormGroup
							label={
								t("settings.fields.health_check_timeout.label") ||
								"Health Check Timeout"
							}
							tooltip={t("settings.fields.health_check_timeout.description")}
							isDirty={isLlmDirty("health_check_timeout")}
						>
							<FormInput
								type="number"
								value={llmConfig.health_check_timeout}
								onChange={(v) =>
									updateLlmManager("health_check_timeout", v as number)
								}
								min={10}
								max={300}
								step={10}
							/>
						</FormGroup>

						<FormGroup
							label={
								t("settings.fields.health_check_interval.label") ||
								"Health Check Interval"
							}
							tooltip={t("settings.fields.health_check_interval.description")}
							isDirty={isLlmDirty("health_check_interval")}
						>
							<FormInput
								type="number"
								value={llmConfig.health_check_interval}
								onChange={(v) =>
									updateLlmManager("health_check_interval", v as number)
								}
								min={0.5}
								max={10}
								step={0.5}
							/>
						</FormGroup>
					</div>
				</CollapsibleSection>
			</SettingsSection>

			{/* Individual Model Settings */}
			<SettingsSection
				title={
					t("settings.sections.models.list_title") || "Model Configurations"
				}
				icon={<Cpu size={18} />}
				description={
					t("settings.sections.models.list_description") ||
					"Configure individual model parameters like context size and GPU layers."
				}
			>
				<div className="grid grid-cols-1 gap-6">
					{Object.entries(modelsConfig).map(([key, config]) => (
						<ModelCard
							key={key}
							name={key}
							config={config}
							onChange={(newConfig) => updateModel(key, newConfig)}
							isEmbedding={key.includes("embedding")}
						/>
					))}
				</div>
			</SettingsSection>
		</div>
	);
};

export default ModelSettings;
