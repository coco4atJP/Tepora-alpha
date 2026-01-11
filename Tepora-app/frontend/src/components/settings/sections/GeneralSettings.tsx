import { Settings } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../hooks/useSettings"; // Import hook
import {
	CollapsibleSection,
	FormGroup,
	FormInput,
	SettingsSection,
} from "../SettingsComponents";

const GeneralSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, originalConfig, updateApp, updateTools } = useSettings();

	if (!config) return null;

	const appConfig = config.app;
	const toolsConfig = config.tools;
	const originalAppConfig = originalConfig?.app;
	const originalToolsConfig = originalConfig?.tools;

	// Helper to check dirty state
	const isDirty = (field: keyof typeof appConfig) => {
		if (!originalAppConfig) return false;
		return appConfig[field] !== originalAppConfig[field];
	};

	const isToolsDirty = (field: keyof typeof toolsConfig) => {
		if (!originalToolsConfig) return false;
		return toolsConfig[field] !== originalToolsConfig[field];
	};

	return (
		<SettingsSection
			title={t("settings.sections.general.label")}
			icon={<Settings size={18} />}
			description={t("settings.sections.general.description")}
		>
			<div className="space-y-6">
				{/* Google Search Configuration */}
				<div className="space-y-4">
					<h3 className="text-lg font-medium text-white">
						{t("settings.sections.general.google_search.title")}
					</h3>
					<FormGroup
						label={t("settings.sections.general.google_search.api_key_label")}
						description={t(
							"settings.sections.general.google_search.api_key_desc",
						)}
						isDirty={isToolsDirty("google_search_api_key")}
					>
						<FormInput
							type="password"
							value={toolsConfig.google_search_api_key || ""}
							onChange={(value) =>
								updateTools("google_search_api_key", value as string)
							}
							placeholder="AIza..."
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.general.google_search.engine_id_label")}
						description={t(
							"settings.sections.general.google_search.engine_id_desc",
						)}
						isDirty={isToolsDirty("google_search_engine_id")}
					>
						<FormInput
							type="text"
							value={toolsConfig.google_search_engine_id || ""}
							onChange={(value) =>
								updateTools("google_search_engine_id", value as string)
							}
							placeholder="0123456789..."
						/>
					</FormGroup>
				</div>

				<div className="border-t border-white/10 my-4" />

				{/* App Settings */}
				<div className="space-y-4">
					<h3 className="text-lg font-medium text-white">
						{t("settings.sections.general.app_settings")}
					</h3>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						<FormGroup
							label={t("settings.fields.language.label")}
							description={t("settings.fields.language.description")}
							isDirty={isDirty("language")}
						>
							<FormInput
								value={appConfig.language}
								onChange={(value) => updateApp("language", value as string)}
								placeholder="ja"
							/>
						</FormGroup>

						<FormGroup
							label={
								t("settings.fields.max_input_length.label") ||
								"Max Input Length"
							}
							description={t("settings.fields.max_input_length.description")}
							isDirty={isDirty("max_input_length")}
						>
							<FormInput
								type="number"
								value={appConfig.max_input_length}
								onChange={(value) =>
									updateApp("max_input_length", value as number)
								}
								min={1000}
								max={100000}
								step={1000}
							/>
						</FormGroup>
					</div>

					<CollapsibleSection
						title={t("settings.sections.general.advanced_settings") || "Advanced Settings"}
						description={t("settings.sections.general.advanced_settings_desc") || "Recursion limits and fetch constraints"}
					>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
							<FormGroup
								label={
									t("settings.fields.graph_recursion_limit.label") ||
									"Graph Recursion Limit"
								}
								tooltip={t("settings.fields.graph_recursion_limit.description")}
								isDirty={isDirty("graph_recursion_limit")}
							>
								<FormInput
									type="number"
									value={appConfig.graph_recursion_limit}
									onChange={(value) =>
										updateApp("graph_recursion_limit", value as number)
									}
									min={1}
									max={200}
									step={1}
								/>
							</FormGroup>

							<FormGroup
								label={
									t("settings.fields.web_fetch_max_chars.label") ||
									"Web Fetch Max Chars"
								}
								tooltip={t("settings.fields.web_fetch_max_chars.description")}
								isDirty={isDirty("web_fetch_max_chars")}
							>
								<FormInput
									type="number"
									value={appConfig.web_fetch_max_chars}
									onChange={(value) =>
										updateApp("web_fetch_max_chars", value as number)
									}
									min={1000}
									max={50000}
									step={1000}
								/>
							</FormGroup>
						</div>
					</CollapsibleSection>
				</div>

				<div className="border-t border-white/10 my-4" />

				{/* Timeout Settings (Collapsible) */}
				<CollapsibleSection
					title={
						t("settings.sections.general.timeout_settings") ||
						"Timeout Settings"
					}
					defaultOpen={false}
				>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
						<FormGroup
							label={
								t("settings.fields.tool_execution_timeout.label") ||
								"Tool Execution Timeout"
							}
							description={t(
								"settings.fields.tool_execution_timeout.description",
							)}
							isDirty={isDirty("tool_execution_timeout")}
						>
							<FormInput
								type="number"
								value={appConfig.tool_execution_timeout}
								onChange={(value) =>
									updateApp("tool_execution_timeout", value as number)
								}
								min={10}
								max={600}
								step={10}
							/>
						</FormGroup>

						<FormGroup
							label={
								t("settings.fields.tool_approval_timeout.label") ||
								"Tool Approval Timeout"
							}
							description={t(
								"settings.fields.tool_approval_timeout.description",
							)}
							isDirty={isDirty("tool_approval_timeout")}
						>
							<FormInput
								type="number"
								value={appConfig.tool_approval_timeout}
								onChange={(value) =>
									updateApp("tool_approval_timeout", value as number)
								}
								min={30}
								max={1800}
								step={30}
							/>
						</FormGroup>
					</div>
				</CollapsibleSection>
			</div>
		</SettingsSection>
	);
};

export default GeneralSettings;
