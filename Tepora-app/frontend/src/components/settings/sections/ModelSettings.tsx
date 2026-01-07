import { Cpu, Server } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import {
	FormGroup,
	FormInput,
	ModelCard,
	type ModelConfig,
	SettingsSection,
} from "../SettingsComponents";

interface LlmManagerConfig {
	process_terminate_timeout: number;
	health_check_timeout: number;
	health_check_interval: number;
	tokenizer_model_key: string;
	cache_size: number;
}

interface ModelSettingsProps {
	llmConfig: LlmManagerConfig;
	modelsConfig: Record<string, ModelConfig>;
	onUpdateLlm: <K extends keyof LlmManagerConfig>(
		field: K,
		value: LlmManagerConfig[K],
	) => void;
	onUpdateModel: (key: string, config: ModelConfig) => void;
}

const ModelSettings: React.FC<ModelSettingsProps> = ({
	llmConfig,
	modelsConfig,
	onUpdateLlm,
	onUpdateModel,
}) => {
	const { t } = useTranslation();

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
					>
						<FormInput
							type="number"
							value={llmConfig.cache_size ?? 1}
							onChange={(v) => onUpdateLlm("cache_size", v as number)}
							min={1}
							max={5}
							step={1}
						/>
					</FormGroup>

					<FormGroup
						label="Tokenizer Model"
						description="Model key used for token counting."
					>
						<FormInput
							value={llmConfig.tokenizer_model_key}
							onChange={(v) => onUpdateLlm("tokenizer_model_key", v as string)}
						/>
					</FormGroup>
				</div>
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
							onChange={(newConfig) => onUpdateModel(key, newConfig)}
							isEmbedding={key.includes("embedding")}
						/>
					))}
				</div>
			</SettingsSection>
		</div>
	);
};

export default ModelSettings;
