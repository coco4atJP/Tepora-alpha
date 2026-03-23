import React from "react";
import { useTranslation } from "react-i18next";
import { SelectionDot } from "../../../../shared/ui/SelectionDot";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";
import { AgentSkillsManagementPanel } from "../components/AgentSkillsManagementPanel";
import { CredentialsManagementPanel } from "../components/CredentialsManagementPanel";
import { McpManagementPanel } from "../components/McpManagementPanel";

const PROVIDER_OPTIONS = [
	{ label: "DuckDuckGo", value: "duckduckgo" },
	{ label: "Google", value: "google" },
	{ label: "Brave", value: "brave" },
	{ label: "Bing", value: "bing" },
];

interface ToolsSettingsProps {
	activeTab?: string;
}

export const ToolsSettings: React.FC<ToolsSettingsProps> = ({
	activeTab = "Web Search",
}) => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const provider = editor.readString("tools.search_provider", "duckduckgo");

	if (activeTab === "Agent Skills") {
		return <AgentSkillsManagementPanel />;
	}

	if (activeTab === "MCP") {
		return <McpManagementPanel />;
	}

	if (activeTab === "Credentials") {
		return <CredentialsManagementPanel />;
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title={t("v2.settings.webSearch", "Web Search")}>
				<SettingsRow label={t("v2.settings.provider", "Provider")}>
					{PROVIDER_OPTIONS.map((option) => (
						<SelectionDot
							key={option.value}
							label={option.label}
							selected={provider === option.value}
							onClick={() => editor.updateField("tools.search_provider", option.value)}
						/>
					))}
				</SettingsRow>
				{provider === "google" ? (
					<>
						<SettingsRow
							label={t("v2.settings.googleApiKey", "Google API Key")}
							description={t("v2.settings.googleApiKeyDescription", "Stored via backend secrets handling when saved")}
						>
							<div className="w-full max-w-xl">
								<TextField
									value={editor.readString("tools.google_search_api_key", "")}
									onChange={(event) =>
										editor.updateField(
											"tools.google_search_api_key",
											event.target.value,
										)
									}
									placeholder={t("v2.settings.googleApiKeyPlaceholder", "Google Custom Search API key")}
								/>
							</div>
						</SettingsRow>
						<SettingsRow label={t("v2.settings.googleEngineId", "Google Engine ID")}>
							<div className="w-full max-w-xl">
								<TextField
									value={editor.readString("tools.google_search_engine_id", "")}
									onChange={(event) =>
										editor.updateField(
											"tools.google_search_engine_id",
											event.target.value,
										)
									}
									placeholder={t("v2.settings.googleEngineIdPlaceholder", "Custom Search Engine ID")}
								/>
							</div>
						</SettingsRow>
					</>
				) : null}
				{provider === "brave" ? (
					<SettingsRow label={t("v2.settings.braveApiKey", "Brave API Key")}>
						<div className="w-full max-w-xl">
							<TextField
								value={editor.readString("tools.brave_search_api_key", "")}
								onChange={(event) =>
									editor.updateField(
										"tools.brave_search_api_key",
										event.target.value,
									)
								}
								placeholder={t("v2.settings.braveApiKeyPlaceholder", "Brave Search API key")}
							/>
						</div>
					</SettingsRow>
				) : null}
				{provider === "bing" ? (
					<SettingsRow label={t("v2.settings.bingApiKey", "Bing API Key")}>
						<div className="w-full max-w-xl">
							<TextField
								value={editor.readString("tools.bing_search_api_key", "")}
								onChange={(event) =>
									editor.updateField(
										"tools.bing_search_api_key",
										event.target.value,
									)
								}
								placeholder={t("v2.settings.bingApiKeyPlaceholder", "Bing Search API key")}
							/>
						</div>
					</SettingsRow>
				) : null}
			</SettingsSectionGroup>
		</div>
	);
};
