import React from "react";
import { useTranslation } from "react-i18next";
import { SelectionDot } from "../../../../shared/ui/SelectionDot";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { readNestedValue, useSettingsEditor } from "../../model/editor";

const PROVIDER_OPTIONS = [
	{ label: "DuckDuckGo", value: "duckduckgo" },
	{ label: "Google", value: "google" },
	{ label: "Brave", value: "brave" },
	{ label: "Bing", value: "bing" },
];

function parseRootPaths(value: string) {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map((path) => ({
			path,
			enabled: true,
		}));
}

interface ToolsSettingsProps {
	activeTab?: string;
}

export const ToolsSettings: React.FC<ToolsSettingsProps> = ({
	activeTab = "Web Search",
}) => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const provider = editor.readString("tools.search_provider", "duckduckgo");
	const rootsValue = editor.draft
		? readNestedValue(editor.draft, "agent_skills.roots")
		: undefined;
	const rootPaths = Array.isArray(rootsValue)
		? rootsValue
				.map((entry) =>
					entry && typeof entry === "object" && "path" in entry
						? String((entry as { path?: unknown }).path ?? "")
						: "",
				)
				.filter(Boolean)
				.join(", ")
		: "";

	if (activeTab === "Agent Skills") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title={t("v2.settings.agentSkills", "Agent Skills")}>
					<SettingsRow
						label={t("v2.settings.skillRoots", "Skill Roots")}
						description={t("v2.settings.skillRootsDescription", "Comma-separated skill root paths stored in backend config")}
					>
						<div className="w-full max-w-2xl">
							<TextField
								value={rootPaths}
								onChange={(event) =>
									editor.updateField(
										"agent_skills.roots",
										parseRootPaths(event.target.value),
									)
								}
								placeholder={t("v2.settings.skillRootsPlaceholder", "/path/to/skills, /another/path")}
							/>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "MCP") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title={t("v2.settings.mcp", "MCP")}>
					<SettingsRow
						label={t("v2.settings.mcpConfigPath", "MCP Config Path")}
						description={t("v2.settings.mcpConfigPathDescription", "Path to the MCP configuration file used by the backend")}
					>
						<div className="w-full max-w-2xl">
							<TextField
								value={editor.readString("app.mcp_config_path", "")}
								onChange={(event) =>
									editor.updateField("app.mcp_config_path", event.target.value)
								}
								placeholder={t("v2.settings.mcpConfigPathPlaceholder", "/absolute/path/to/mcp_tools_config.json")}
							/>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "Credentials") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title={t("v2.settings.credentials", "Credentials")}>
					<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
						{t("v2.settings.credentialsDescription", "Credentials are edited inline on each provider tab and saved through the backend secret store.")}
					</div>
				</SettingsSectionGroup>
			</div>
		);
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
