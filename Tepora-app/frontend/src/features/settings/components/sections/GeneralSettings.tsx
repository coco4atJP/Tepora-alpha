import { Brain, Languages, Palette, Search, Settings2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../components/ui/Button";
import { useSettings } from "../../../../hooks/useSettings";
import type { CredentialStatus } from "../../../../types";
import { apiClient } from "../../../../utils/api-client";
import { ENDPOINTS } from "../../../../utils/endpoints";
import { ThemeSelector } from "../components/ThemeSelector";
import { FormGroup, FormInput, FormList, FormSelect, FormSwitch, SettingsSection } from "../SettingsComponents";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPathValue<T>(source: unknown, path: string, fallback: T): T {
	const keys = path.split(".").filter(Boolean);
	let current: unknown = source;

	for (const key of keys) {
		if (!isRecord(current)) return fallback;
		current = current[key];
	}

	if (current === undefined || current === null) return fallback;
	return current as T;
}

const statusTone: Record<string, string> = {
	active: "bg-emerald-500/10 text-emerald-200 border-emerald-500/20",
	expiring_soon: "bg-amber-500/10 text-amber-200 border-amber-500/20",
	expired: "bg-red-500/10 text-red-200 border-red-500/20",
	missing: "bg-white/5 text-gray-300 border-white/10",
};

const providerFieldMap = {
	google_search: "google_search_api_key",
	brave_search: "brave_search_api_key",
	bing_search: "bing_search_api_key",
} as const;

const providerLabels: Record<string, string> = {
	google_search: "Google Search",
	brave_search: "Brave Search",
	bing_search: "Bing Search",
};

const formatTimestamp = (value?: string | null) => value ? new Date(value).toLocaleString() : "-";

const GeneralSettings: React.FC = () => {
	const { t, i18n } = useTranslation();
	const { config, originalConfig, updateApp, updateTools, updateThinking, updateConfigPath, fetchConfig } = useSettings();
	const [credentialStatuses, setCredentialStatuses] = useState<CredentialStatus[]>([]);
	const [credentialLoading, setCredentialLoading] = useState(false);
	const [credentialExpiryDrafts, setCredentialExpiryDrafts] = useState<Record<string, string>>({});
	const [rotatingProvider, setRotatingProvider] = useState<string | null>(null);

	const refreshCredentialStatuses = async () => {
		setCredentialLoading(true);
		try {
			const data = await apiClient.get<{ credentials: CredentialStatus[] }>(ENDPOINTS.CREDENTIALS.STATUS);
			const nextStatuses = data.credentials || [];
			setCredentialStatuses(nextStatuses);
			setCredentialExpiryDrafts((prev) => {
				const next = { ...prev };
				for (const status of nextStatuses) {
					if (!(status.provider in next)) {
						next[status.provider] = status.expires_at ?? "";
					}
				}
				return next;
			});
		} catch (error) {
			console.error("Failed to load credential statuses", error);
		} finally {
			setCredentialLoading(false);
		}
	};

	useEffect(() => {
		void refreshCredentialStatuses();
	}, []);

	if (!config) return null;

	const appConfig = config.app;
	const toolsConfig = config.tools || {};
	const originalAppConfig = originalConfig?.app;
	const originalToolsConfig = originalConfig?.tools || {};

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

	const readString = (path: string, fallback = "") => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "string" ? value : fallback;
	};

	const readNumber = (path: string, fallback = 0) => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};

	const readBoolean = (path: string, fallback = false) => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "boolean" ? value : fallback;
	};

	const readStringList = (path: string) => {
		const value = getPathValue<unknown>(config, path, []);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	};

	const handleRotateCredential = async (provider: keyof typeof providerFieldMap) => {
		const secretField = providerFieldMap[provider];
		const secret = String(toolsConfig[secretField] || "");
		if (!secret.trim()) return;
		setRotatingProvider(provider);
		try {
			await apiClient.post(ENDPOINTS.CREDENTIALS.ROTATE, {
				provider,
				secret,
				expires_at: credentialExpiryDrafts[provider]?.trim() || undefined,
			});
			await fetchConfig();
			await refreshCredentialStatuses();
		} catch (error) {
			console.error("Failed to rotate credential", error);
		} finally {
			setRotatingProvider(null);
		}
	};

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
				title={t("settings.thinking.title", "Thinking Process")}
				icon={<Brain size={18} />}
				description={t("settings.thinking.description", "Configure the default behavior of the thinking process.")}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.thinking.chat_default", "Default: Enable in Chat")}
						description={t("settings.thinking.chat_default_desc", "Automatically enable thinking process when starting a new chat session.")}
					>
						<FormSwitch
							checked={config.thinking?.chat_default ?? false}
							onChange={(checked) => updateThinking("chat_default", checked)}
						/>
					</FormGroup>
					<FormGroup
						label={t("settings.thinking.search_default", "Default: Enable in Search")}
						description={t("settings.thinking.search_default_desc", "Automatically enable thinking process when starting a new search session.")}
					>
						<FormSwitch
							checked={config.thinking?.search_default ?? false}
							onChange={(checked) => updateThinking("search_default", checked)}
						/>
					</FormGroup>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.extended.ui_title", "UI Design & Notifications")}
				icon={<Palette size={18} />}
				description={t("settings.sections.extended.ui_description", "Configure appearance details and background notifications.")}
			>
				<div className="space-y-4">
					<FormGroup label={t("settings.sections.extended.font_family", "Font Family")} description={t("settings.sections.extended.font_family_desc", "UI font family for main text rendering.")}>
						<FormInput value={readString("ui.font_family", "")} onChange={(value) => updateConfigPath("ui.font_family", value)} placeholder={t("settings.sections.extended.font_family_placeholder", "e.g. Noto Sans")} />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.font_size", "Font Size")} description={t("settings.sections.extended.font_size_desc", "Base UI font size in pixels.")}>
						<FormInput type="number" value={readNumber("ui.font_size", 14)} onChange={(value) => updateConfigPath("ui.font_size", value)} min={10} max={32} step={1} />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.code_theme", "Code Highlight Theme")} description={t("settings.sections.extended.code_theme_desc", "Syntax highlighting theme for code blocks.")}>
						<FormInput value={readString("ui.code_block.syntax_theme", "")} onChange={(value) => updateConfigPath("ui.code_block.syntax_theme", value)} placeholder={t("settings.sections.extended.code_theme_placeholder", "e.g. github-dark")} />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.thinking_max_tokens", "Thinking Max Tokens")} description={t("settings.sections.extended.thinking_max_tokens_desc", "Upper limit for thinking token consumption.")}>
						<FormInput type="number" value={readNumber("thinking.max_tokens", 0)} onChange={(value) => updateConfigPath("thinking.max_tokens", value)} min={0} max={262144} step={64} />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.code_wrap", "Code Block Wrap")} description={t("settings.sections.extended.code_wrap_desc", "Enable line wrapping for code blocks.")}>
						<FormSwitch checked={readBoolean("ui.code_block.wrap_lines", true)} onChange={(value) => updateConfigPath("ui.code_block.wrap_lines", value)} />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.code_line_numbers", "Code Block Line Numbers")} description={t("settings.sections.extended.code_line_numbers_desc", "Display line numbers in code blocks.")}>
						<FormSwitch checked={readBoolean("ui.code_block.show_line_numbers", true)} onChange={(value) => updateConfigPath("ui.code_block.show_line_numbers", value)} />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.notification_os", "Background Task OS Notification")} description={t("settings.sections.extended.notification_os_desc", "Show an OS notification when background tasks complete.")}>
						<FormSwitch checked={readBoolean("notifications.background_task.os_notification", false)} onChange={(value) => updateConfigPath("notifications.background_task.os_notification", value)} />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.notification_sound", "Background Task Sound")} description={t("settings.sections.extended.notification_sound_desc", "Play a notification sound when background tasks complete.")}>
						<FormSwitch checked={readBoolean("notifications.background_task.sound", false)} onChange={(value) => updateConfigPath("notifications.background_task.sound", value)} />
					</FormGroup>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.extended.shortcuts_title", "Shortcuts")}
				icon={<Settings2 size={18} />}
				description={t("settings.sections.extended.shortcuts_description", "Configure keyboard shortcuts for quick actions.")}
			>
				<div className="space-y-4">
					<FormGroup label={t("settings.sections.extended.shortcut_new_chat", "Shortcut: New Chat")} description={t("settings.sections.extended.shortcut_new_chat_desc", "Keyboard shortcut for starting a new chat.")}>
						<FormInput value={readString("shortcuts.new_chat", "")} onChange={(value) => updateConfigPath("shortcuts.new_chat", value)} placeholder="Ctrl+Shift+N" />
					</FormGroup>
					<FormGroup label={t("settings.sections.extended.shortcut_custom", "Additional Shortcuts")} description={t("settings.sections.extended.shortcut_custom_desc", "Add shortcuts as action=keybinding (for example: open_settings=Ctrl+,).")}
						orientation="vertical">
						<FormList items={readStringList("shortcuts.custom_bindings")} onChange={(items) => updateConfigPath("shortcuts.custom_bindings", items)} placeholder="open_settings=Ctrl+," />
					</FormGroup>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.general.search_tool.title")}
				icon={<Search size={18} />}
				description={t("settings.sections.general.search_tool.description", "Choose the search engine and credentials used for web search.")}
			>
				<div className="space-y-4">
					<FormGroup label={t("settings.sections.general.search_tool.provider_label")} description={t("settings.sections.general.search_tool.provider_desc")} isDirty={isToolsDirty("search_provider")}>
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
							<FormGroup label={t("settings.sections.general.google_search.api_key_label")} description={t("settings.sections.general.google_search.api_key_desc")} isDirty={isToolsDirty("google_search_api_key")}>
								<FormInput type="password" value={toolsConfig.google_search_api_key || ""} onChange={(value) => updateTools("google_search_api_key", value as string)} placeholder={t("settings.placeholders.google_api_key")} />
							</FormGroup>
							<FormGroup label={t("settings.sections.general.google_search.engine_id_label")} description={t("settings.sections.general.google_search.engine_id_desc")} isDirty={isToolsDirty("google_search_engine_id")}>
								<FormInput type="text" value={toolsConfig.google_search_engine_id || ""} onChange={(value) => updateTools("google_search_engine_id", value as string)} placeholder={t("settings.placeholders.google_engine_id")} />
							</FormGroup>
						</>
					)}

					{toolsConfig.search_provider === "brave" && (
						<FormGroup label={t("settings.sections.general.brave_search.api_key_label")} description={t("settings.sections.general.brave_search.api_key_desc")} isDirty={isToolsDirty("brave_search_api_key")}>
							<FormInput type="password" value={toolsConfig.brave_search_api_key || ""} onChange={(value) => updateTools("brave_search_api_key", value as string)} placeholder="BSA..." />
						</FormGroup>
					)}

					{toolsConfig.search_provider === "bing" && (
						<FormGroup label={t("settings.sections.general.bing_search.api_key_label")} description={t("settings.sections.general.bing_search.api_key_desc")} isDirty={isToolsDirty("bing_search_api_key")}>
							<FormInput type="password" value={toolsConfig.bing_search_api_key || ""} onChange={(value) => updateTools("bing_search_api_key", value as string)} placeholder="Ocp-Apim-Subscription-Key" />
						</FormGroup>
					)}

					<div className="border-t border-white/10 pt-4 space-y-4">
						<div className="flex items-center justify-between gap-3">
							<div>
								<h4 className="text-sm font-semibold text-white">
									{t("settings.credentials.title", "Credential lifecycle")}
								</h4>
								<p className="text-xs text-gray-400">
									{t("settings.credentials.desc", "Track expiry, last rotation time, and persist updated key metadata.")}
								</p>
							</div>
							<Button variant="secondary" onClick={() => void refreshCredentialStatuses()} isLoading={credentialLoading}>
								{t("common.refresh", "Refresh")}
							</Button>
						</div>

						{credentialStatuses.map((status) => {
							const field = providerFieldMap[status.provider as keyof typeof providerFieldMap];
							const secretValue = field ? String(toolsConfig[field] || "") : "";
							return (
								<div key={status.provider} className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-3">
									<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
										<div>
											<div className="text-sm font-medium text-white">{providerLabels[status.provider] || status.provider}</div>
											<div className="text-xs text-gray-400 mt-1">
												{t("settings.credentials.last_rotated", "Last rotated")}: {formatTimestamp(status.last_rotated_at)}
											</div>
										</div>
										<span className={`px-2.5 py-1 rounded-full border text-xs ${statusTone[status.status] || statusTone.missing}`}>
											{status.status}
										</span>
									</div>

									<FormGroup label={t("settings.credentials.expires_at", "Expires at (RFC3339)")} description={t("settings.credentials.expires_at_desc", "Example: 2026-04-01T00:00:00+09:00")}>
										<FormInput
											value={credentialExpiryDrafts[status.provider] ?? ""}
											onChange={(value) =>
												setCredentialExpiryDrafts((prev) => ({ ...prev, [status.provider]: String(value) }))}
											placeholder="2026-04-01T00:00:00+09:00"
										/>
									</FormGroup>

									<div className="flex items-center justify-between gap-3 text-xs text-gray-400">
										<span>
											{t("settings.credentials.current_expiry", "Current expiry")}: {formatTimestamp(status.expires_at)}
										</span>
										<Button
											variant="primary"
											onClick={() => void handleRotateCredential(status.provider as keyof typeof providerFieldMap)}
											isLoading={rotatingProvider === status.provider}
											disabled={!secretValue.trim()}
										>
											{t("settings.credentials.rotate", "Save key and update metadata")}
										</Button>
									</div>
									{!status.present && (
										<p className="text-xs text-gray-500">
											{t("settings.credentials.missing", "Enter a key above before rotating this credential.")}
										</p>
									)}
								</div>
							);
						})}
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.general.advanced_settings")}
				icon={<Settings2 size={18} />}
				description={t("settings.sections.general.advanced_settings_desc")}
			>
				<div className="space-y-4">
					<FormGroup label={t("settings.fields.graph_recursion_limit.label")} tooltip={t("settings.fields.graph_recursion_limit.description")} isDirty={isDirty("graph_recursion_limit")}>
						<FormInput type="number" value={appConfig.graph_recursion_limit} onChange={(value) => updateApp("graph_recursion_limit", value as number)} min={1} max={200} step={1} />
					</FormGroup>
					<FormGroup label={t("settings.fields.max_input_length.label")} description={t("settings.fields.max_input_length.description")} isDirty={isDirty("max_input_length")}>
						<FormInput type="number" value={appConfig.max_input_length} onChange={(value) => updateApp("max_input_length", value as number)} min={1000} max={100000} step={1000} />
					</FormGroup>
					<FormGroup label={t("settings.fields.web_fetch_max_chars.label")} tooltip={t("settings.fields.web_fetch_max_chars.description")} isDirty={isDirty("web_fetch_max_chars")}>
						<FormInput type="number" value={appConfig.web_fetch_max_chars} onChange={(value) => updateApp("web_fetch_max_chars", value as number)} min={1000} max={50000} step={1000} />
					</FormGroup>
					<FormGroup label={t("settings.fields.web_fetch_max_bytes.label", "Web Fetch Max Bytes")} tooltip={t("settings.fields.web_fetch_max_bytes.description", "Maximum response size in bytes for web fetch (1KB - 10MB).")} isDirty={isDirty("web_fetch_max_bytes")}>
						<FormInput type="number" value={appConfig.web_fetch_max_bytes || 1000000} onChange={(value) => updateApp("web_fetch_max_bytes", value as number)} min={1024} max={10000000} step={10000} />
					</FormGroup>
					<FormGroup label={t("settings.fields.web_fetch_timeout_secs.label", "Web Fetch Timeout (sec)")} tooltip={t("settings.fields.web_fetch_timeout_secs.description", "Timeout in seconds for web fetch requests (1 - 120).")} isDirty={isDirty("web_fetch_timeout_secs")}>
						<FormInput type="number" value={appConfig.web_fetch_timeout_secs || 10} onChange={(value) => updateApp("web_fetch_timeout_secs", value as number)} min={1} max={120} step={1} />
					</FormGroup>
					<FormGroup label={t("settings.fields.graph_execution_timeout.label", "Graph Execution Timeout (ms)")} tooltip={t("settings.fields.graph_execution_timeout.description", "Maximum time allowed for graph execution (1s - 1h).")} isDirty={isDirty("graph_execution_timeout")}>
						<FormInput type="number" value={appConfig.graph_execution_timeout || 30000} onChange={(value) => updateApp("graph_execution_timeout", value as number)} min={1000} max={3600000} step={1000} />
					</FormGroup>
				</div>
			</SettingsSection>
		</div>
	);
};

export default GeneralSettings;
