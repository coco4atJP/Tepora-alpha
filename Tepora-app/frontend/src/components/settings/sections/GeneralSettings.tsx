import { Cpu, Settings } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../hooks/useSettings";
import { getApiBase, getAuthHeaders } from "../../../utils/api";
import { ThemeSelector } from "../components/ThemeSelector";
import Updater from "../components/Updater";
import {
	CollapsibleSection,
	FormGroup,
	FormInput,
	FormSelect,
	SettingsSection,
} from "../SettingsComponents";

const GeneralSettings: React.FC = () => {
	const { t, i18n } = useTranslation();
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

	const supportedLanguages = new Set(["en", "ja", "es", "zh"]);
	const normalizeLanguage = (lang?: string): string | null => {
		if (!lang) return null;
		const normalized = lang.toLowerCase().split(/[-_]/)[0] || "";
		return supportedLanguages.has(normalized) ? normalized : null;
	};

	const configLanguage = normalizeLanguage(appConfig.language) ?? "en";
	const uiLanguage =
		normalizeLanguage(i18n.resolvedLanguage || i18n.language) ?? configLanguage;
	const languageSelectValue = appConfig.setup_completed
		? configLanguage
		: uiLanguage;

	return (
		<SettingsSection
			title={t("settings.sections.general.label")}
			icon={<Settings size={18} />}
			description={t("settings.sections.general.description")}
		>
			<div className="space-y-6">
				{/* App Updater */}
				<Updater />

				<div className="border-t border-white/10 my-4" />

				{/* Inference Engine Update */}
				<InferenceEngineUpdate />

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

					{/* Theme Selection */}
					<ThemeSelector />

					<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
						title={
							t("settings.sections.general.advanced_settings") ||
							"Advanced Settings"
						}
						description={
							t("settings.sections.general.advanced_settings_desc") ||
							"Recursion limits and fetch constraints"
						}
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

// Sub-component for llama.cpp Update Logic
const InferenceEngineUpdate: React.FC = () => {
	const { t } = useTranslation();
	const [checking, setChecking] = useState(false);
	const [updateInfo, setUpdateInfo] = useState<{
		has_update: boolean;
		current_version: string;
		latest_version?: string;
	} | null>(null);
	const [updating, setUpdating] = useState(false);
	const [status, setStatus] = useState("");
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const checkUpdate = useCallback(async () => {
		try {
			setChecking(true);
			const res = await fetch(
				`${getApiBase()}/api/setup/binary/update-info?t=${Date.now()}`,
				{ headers: { ...getAuthHeaders() } },
			);
			const data = await res.json();
			setUpdateInfo(data);
		} catch (e) {
			console.error(e);
		} finally {
			setChecking(false);
		}
	}, []);

	const doUpdate = async () => {
		try {
			setUpdating(true);
			setStatus(
				t("settings.sections.general.inference_engine.starting") ||
					"Starting update...",
			);
			const res = await fetch(`${getApiBase()}/api/setup/binary/update`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...getAuthHeaders() },
				body: JSON.stringify({ variant: "auto" }),
			});
			const data = await res.json();

			if (data.job_id) {
				// Poll progress
				pollRef.current = setInterval(async () => {
					const progRes = await fetch(
						`${getApiBase()}/api/setup/progress?job_id=${data.job_id}`,
						{ headers: { ...getAuthHeaders() } },
					);
					const progData = await progRes.json();
					setStatus(progData.message || `Status: ${progData.status}`);

					if (progData.status === "completed") {
						if (pollRef.current) clearInterval(pollRef.current);
						pollRef.current = null;
						setUpdating(false);
						setStatus(
							t("settings.sections.general.inference_engine.completed") ||
								"Update completed!",
						);
						checkUpdate();
					} else if (progData.status === "failed") {
						if (pollRef.current) clearInterval(pollRef.current);
						pollRef.current = null;
						setUpdating(false);
						setStatus(
							`${t("settings.sections.general.inference_engine.failed") || "Update failed"}: ${progData.message}`,
						);
					}
				}, 1000);
			} else {
				setUpdating(false);
				setStatus(
					t("settings.sections.general.inference_engine.start_failed") ||
						"Failed to start update",
				);
			}
		} catch (e) {
			console.error(e);
			setUpdating(false);
			setStatus(
				t("settings.sections.general.inference_engine.error") ||
					"Error starting update",
			);
		}
	};

	useEffect(() => {
		checkUpdate();
		return () => {
			// Cleanup: clear polling interval on unmount to prevent memory leaks
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};
	}, [checkUpdate]);

	return (
		<CollapsibleSection
			title={
				t("settings.sections.general.inference_engine.title") ||
				"Inference Engine (llama.cpp)"
			}
			description={
				t("settings.sections.general.inference_engine.description") ||
				"Manage llama.cpp binary updates"
			}
			defaultOpen={false}
		>
			<div className="bg-black/20 rounded-lg p-4 border border-white/5">
				<div className="flex items-center justify-between">
					<div>
						<div className="text-sm text-gray-400 mb-1">
							{t(
								"settings.sections.general.inference_engine.current_version",
							) || "Current Version"}
						</div>
						<div className="font-mono text-green-400">
							{updateInfo?.current_version || "Unknown"}
						</div>
					</div>

					<div className="flex gap-3 items-center">
						{updateInfo?.has_update && (
							<div className="text-right">
								<div className="text-xs text-yellow-400">
									{t(
										"settings.sections.general.inference_engine.new_available",
									) || "New Version Available"}
								</div>
								<div className="font-mono text-white text-sm">
									{updateInfo.latest_version}
								</div>
							</div>
						)}

						{updating ? (
							<div className="flex items-center gap-2 px-4 py-2 bg-coffee-500/10 text-coffee-400 rounded-lg text-sm">
								<span className="w-2 h-2 rounded-full bg-coffee-400 animate-pulse" />
								{status}
							</div>
						) : updateInfo?.has_update ? (
							<button
								type="button"
								onClick={doUpdate}
								className="px-4 py-2 bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded-lg text-sm transition-colors flex items-center gap-2"
							>
								<Cpu size={14} />
								{t("common.update_now") || "Update Now"}
							</button>
						) : (
							<button
								type="button"
								onClick={checkUpdate}
								disabled={checking}
								className="px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg text-sm transition-colors"
							>
								{checking
									? t("settings.sections.general.inference_engine.checking") ||
										"Checking..."
									: t(
											"settings.sections.general.inference_engine.check_updates",
										) || "Check for Updates"}
							</button>
						)}
					</div>
				</div>
			</div>
		</CollapsibleSection>
	);
};

export default GeneralSettings;
