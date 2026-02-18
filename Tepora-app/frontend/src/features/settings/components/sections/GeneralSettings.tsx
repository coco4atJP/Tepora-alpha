import { Languages, Palette, Search, Settings2 } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
import { ThemeSelector } from "../components/ThemeSelector";
import { FormGroup, FormInput, FormSelect, SettingsSection } from "../SettingsComponents";

const GeneralSettings: React.FC = () => {
	const { t, i18n } = useTranslation();
	const { config, originalConfig, updateApp, updateTools } = useSettings();

	if (!config) return null;

	const appConfig = config.app;
	const toolsConfig = config.tools || {};
	const originalAppConfig = originalConfig?.app;
	const originalToolsConfig = originalConfig?.tools || {};

	// Helper to check dirty state
	const isDirty = (field: keyof typeof appConfig) => {
		if (!originalAppConfig) return false;
		return appConfig[field] !== originalAppConfig[field];
	};

	const isToolsDirty = (field: keyof typeof toolsConfig) => {
		if (!originalToolsConfig) return false;
		return toolsConfig[field] !== originalToolsConfig[field];
	};

	const supportedLanguages = new Set(["en", "ja", "es", "zh"]);
	const normalizeLanguage = (lang?: string): string | null => {
		if (!lang) return null;
		const normalized = lang.toLowerCase().split(/[-_]/)[0] || "";
		return supportedLanguages.has(normalized) ? normalized : null;
	};

	const configLanguage = normalizeLanguage(appConfig.language) ?? "en";
	const uiLanguage = normalizeLanguage(i18n.resolvedLanguage || i18n.language) ?? configLanguage;
	const languageSelectValue = appConfig.setup_completed ? configLanguage : uiLanguage;

	return (
		<div className="space-y-6">
			<SettingsSection
				title={t("settings.appearance.title")}
				icon={<Palette size={18} />}
				description={t("settings.appearance.description", "Choose your preferred theme.")}
			>
				<div className="delay-100 settings-form-group">
					<ThemeSelector />
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.fields.language.label")}
				icon={<Languages size={18} />}
				description={t("settings.fields.language.description")}
			>
				<FormGroup
					label={t("settings.fields.language.label")}
					description={t("settings.fields.language.description")}
					isDirty={isDirty("language")}
				>
					<FormSelect
						value={languageSelectValue}
						onChange={(value) => {
							if (!appConfig.setup_completed) {
								i18n.changeLanguage(value);
							}
							updateApp("language", value as string);
						}}
						options={[
							{ value: "en", label: "English" },
							{ value: "ja", label: "日本語" },
							{ value: "es", label: "Español" },
							{ value: "zh", label: "中文" },
						]}
					/>
				</FormGroup>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.general.search_tool.title")}
				icon={<Search size={18} />}
				description={t(
					"settings.sections.general.search_tool.description",
					"Choose the search engine and credentials used for web search.",
				)}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.sections.general.search_tool.provider_label")}
						description={t("settings.sections.general.search_tool.provider_desc")}
						isDirty={isToolsDirty("search_provider")}
						className="delay-200"
					>
						<FormSelect
							value={toolsConfig.search_provider || "google"}
							onChange={(value) => updateTools("search_provider", value as "google" | "duckduckgo" | "brave" | "bing")}
							options={[
								{ value: "google", label: t("settings.search.providers.google") },
								{ value: "duckduckgo", label: t("settings.search.providers.duckduckgo") },
								{ value: "brave", label: t("settings.search.providers.brave") },
								{ value: "bing", label: t("settings.search.providers.bing") },
							]}
						/>
					</FormGroup>

					{(toolsConfig.search_provider === "google" || !toolsConfig.search_provider) && (
						<>
							<FormGroup
								label={t("settings.sections.general.google_search.api_key_label")}
								description={t("settings.sections.general.google_search.api_key_desc")}
								isDirty={isToolsDirty("google_search_api_key")}
								className="delay-300"
							>
								<FormInput
									type="password"
									value={toolsConfig.google_search_api_key || ""}
									onChange={(value) => updateTools("google_search_api_key", value as string)}
									placeholder={t("settings.placeholders.google_api_key")}
								/>
							</FormGroup>

							<FormGroup
								label={t("settings.sections.general.google_search.engine_id_label")}
								description={t("settings.sections.general.google_search.engine_id_desc")}
								isDirty={isToolsDirty("google_search_engine_id")}
								className="delay-400"
							>
								<FormInput
									type="text"
									value={toolsConfig.google_search_engine_id || ""}
									onChange={(value) => updateTools("google_search_engine_id", value as string)}
									placeholder={t("settings.placeholders.google_engine_id")}
								/>
							</FormGroup>
						</>
					)}

					{toolsConfig.search_provider === "brave" && (
						<FormGroup
							label={t("settings.sections.general.brave_search.api_key_label")}
							description={t("settings.sections.general.brave_search.api_key_desc")}
							isDirty={isToolsDirty("brave_search_api_key")}
							className="delay-300"
						>
							<FormInput
								type="password"
								value={toolsConfig.brave_search_api_key || ""}
								onChange={(value) => updateTools("brave_search_api_key", value as string)}
								placeholder="BSA..."
							/>
						</FormGroup>
					)}

					{toolsConfig.search_provider === "bing" && (
						<FormGroup
							label={t("settings.sections.general.bing_search.api_key_label")}
							description={t("settings.sections.general.bing_search.api_key_desc")}
							isDirty={isToolsDirty("bing_search_api_key")}
							className="delay-300"
						>
							<FormInput
								type="password"
								value={toolsConfig.bing_search_api_key || ""}
								onChange={(value) => updateTools("bing_search_api_key", value as string)}
								placeholder="Ocp-Apim-Subscription-Key"
							/>
						</FormGroup>
					)}
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.general.advanced_settings")}
				icon={<Settings2 size={18} />}
				description={t("settings.sections.general.advanced_settings_desc")}
			>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
					<FormGroup
						label={t("settings.fields.graph_recursion_limit.label")}
						tooltip={t("settings.fields.graph_recursion_limit.description")}
						isDirty={isDirty("graph_recursion_limit")}
					>
						<FormInput
							type="number"
							value={appConfig.graph_recursion_limit}
							onChange={(value) => updateApp("graph_recursion_limit", value as number)}
							min={1}
							max={200}
							step={1}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.max_input_length.label")}
						description={t("settings.fields.max_input_length.description")}
						isDirty={isDirty("max_input_length")}
					>
						<FormInput
							type="number"
							value={appConfig.max_input_length}
							onChange={(value) => updateApp("max_input_length", value as number)}
							min={1000}
							max={100000}
							step={1000}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.web_fetch_max_chars.label")}
						tooltip={t("settings.fields.web_fetch_max_chars.description")}
						isDirty={isDirty("web_fetch_max_chars")}
					>
						<FormInput
							type="number"
							value={appConfig.web_fetch_max_chars}
							onChange={(value) => updateApp("web_fetch_max_chars", value as number)}
							min={1000}
							max={50000}
							step={1000}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.graph_execution_timeout.label", "Graph Execution Timeout (ms)")}
						tooltip={t("settings.fields.graph_execution_timeout.description", "Maximum time allowed for graph execution (1s - 1h).")}
						isDirty={isDirty("graph_execution_timeout")}
					>
						<FormInput
							type="number"
							value={appConfig.graph_execution_timeout || 30000} // Default 30s
							onChange={(value) => updateApp("graph_execution_timeout", value as number)}
							min={1000}
							max={3600000}
							step={1000}
						/>
					</FormGroup>
				</div>
			</SettingsSection>
		</div>
	);
};



export default GeneralSettings;
