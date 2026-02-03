import { Clock, Cpu, Download } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
import { apiClient } from "../../../../utils/api-client";
import Updater from "../components/Updater";
import {
	CollapsibleSection,
	FormGroup,
	FormInput,
	FormSelect,
	SettingsSection,
} from "../SettingsComponents";

const OtherSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, originalConfig, updateApp, updateLlmManager } = useSettings();

	if (!config) return null;

	const appConfig = config.app;
	const llmConfig = config.llm_manager;
	const originalAppConfig = originalConfig?.app;
	const originalLlmConfig = originalConfig?.llm_manager;

	// Helper to check dirty state
	const isDirty = (field: keyof typeof appConfig) => {
		if (!originalAppConfig) return false;
		return appConfig[field] !== originalAppConfig[field];
	};

	const isLlmDirty = (field: keyof typeof llmConfig) => {
		if (!originalLlmConfig) return false;
		return llmConfig[field] !== originalLlmConfig[field];
	};

	return (
		<div className="space-y-8">
			{/* Updates Section */}
			<SettingsSection
				title={t("settings.sections.other.updates.title", "Updates")}
				icon={<Download size={18} />}
				description={t(
					"settings.sections.other.updates.description",
					"Manage application and engine updates",
				)}
			>
				<div className="space-y-6 w-full">
					{/* App Updater */}
					<div className="delay-0 settings-form-group">
						<h3 className="text-sm font-medium text-gray-300 mb-3">
							{t("settings.sections.general.app_updater", "Application Update")}
						</h3>
						<Updater />
					</div>

					<div className="border-t border-white/10 my-4" />

					{/* Inference Engine Update */}
					<div className="delay-100 settings-form-group">
						<InferenceEngineUpdate />
					</div>
				</div>
			</SettingsSection>

			{/* Timeouts Section */}
			<SettingsSection
				title={t("settings.sections.general.timeout_settings", "Timeouts")}
				icon={<Clock size={18} />}
				description={t(
					"settings.sections.other.timeouts.description",
					"Configure execution limits",
				)}
			>
				<div className="space-y-6">
					<div className="space-y-4">
						<h3 className="text-sm font-medium text-gray-300">
							{t("settings.sections.other.timeouts.model_manager", "Model Manager")}
						</h3>
						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
							<FormGroup
								label={
									t("settings.models_settings.global_manager.terminate_timeout") ||
									"Terminate Timeout"
								}
								isDirty={isLlmDirty("process_terminate_timeout")}
							>
								<FormInput
									type="number"
									value={llmConfig.process_terminate_timeout}
									onChange={(v) =>
										updateLlmManager("process_terminate_timeout", v as number)
									}
									min={1}
								/>
							</FormGroup>
							<FormGroup
								label={
									t("settings.models_settings.global_manager.health_check_timeout") ||
									"Health Check Timeout"
								}
								isDirty={isLlmDirty("health_check_timeout")}
							>
								<FormInput
									type="number"
									value={llmConfig.health_check_timeout}
									onChange={(v) => updateLlmManager("health_check_timeout", v as number)}
									min={1}
								/>
							</FormGroup>
							<FormGroup
								label={
									t("settings.models_settings.global_manager.health_check_interval") ||
									"Health Check Interval"
								}
								isDirty={isLlmDirty("health_check_interval")}
							>
								<FormInput
									type="number"
									value={llmConfig.health_check_interval}
									onChange={(v) =>
										updateLlmManager("health_check_interval", v as number)
									}
									step={0.1}
								/>
							</FormGroup>
							<FormGroup
								label={
									t("settings.models_settings.global_manager.tokenizer_model") ||
									"Tokenizer Model"
								}
								isDirty={isLlmDirty("tokenizer_model_key")}
							>
								<FormSelect
									value={llmConfig.tokenizer_model_key}
									onChange={(v) => updateLlmManager("tokenizer_model_key", v as string)}
									options={[
										{ value: "text_model", label: "Text" },
										{ value: "embedding_model", label: "Embedding" },
									]}
								/>
							</FormGroup>
						</div>
					</div>

					<div className="border-t border-white/10" />

					<div className="space-y-4">
						<h3 className="text-sm font-medium text-gray-300">
							{t("settings.sections.other.timeouts.tools", "Tools")}
						</h3>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
							<FormGroup
								label={t("settings.fields.tool_execution_timeout.label") || "Tool Execution Timeout"}
								description={t("settings.fields.tool_execution_timeout.description")}
								isDirty={isDirty("tool_execution_timeout")}
							>
								<FormInput
									type="number"
									value={appConfig.tool_execution_timeout}
									onChange={(value) => updateApp("tool_execution_timeout", value as number)}
									min={10}
									max={600}
									step={10}
								/>
							</FormGroup>

							<FormGroup
								label={t("settings.fields.tool_approval_timeout.label") || "Tool Approval Timeout"}
								description={t("settings.fields.tool_approval_timeout.description")}
								isDirty={isDirty("tool_approval_timeout")}
							>
								<FormInput
									type="number"
									value={appConfig.tool_approval_timeout}
									onChange={(value) => updateApp("tool_approval_timeout", value as number)}
									min={30}
									max={1800}
									step={30}
								/>
							</FormGroup>
						</div>
					</div>
				</div>
			</SettingsSection>
		</div>
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
			const data = await apiClient.get<{
				has_update: boolean;
				current_version: string;
				latest_version?: string;
			}>(`api/setup/binary/update-info?t=${Date.now()}`);
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
			setStatus(t("settings.sections.general.inference_engine.starting") || "Starting update...");
			const data = await apiClient.post<{ job_id?: string }>("api/setup/binary/update", {
				variant: "auto",
			});

			if (data.job_id) {
				// Poll progress
				pollRef.current = setInterval(async () => {
					const progData = await apiClient.get<{
						status: string;
						message?: string;
					}>(`api/setup/progress?job_id=${data.job_id}`);
					setStatus(progData.message || `Status: ${progData.status}`);

					if (progData.status === "completed") {
						if (pollRef.current) clearInterval(pollRef.current);
						pollRef.current = null;
						setUpdating(false);
						setStatus(
							t("settings.sections.general.inference_engine.completed") || "Update completed!",
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
					t("settings.sections.general.inference_engine.start_failed") || "Failed to start update",
				);
			}
		} catch (e) {
			console.error(e);
			setUpdating(false);
			setStatus(t("settings.sections.general.inference_engine.error") || "Error starting update");
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
				t("settings.sections.general.inference_engine.title") || "Inference Engine (llama.cpp)"
			}
			description={
				t("settings.sections.general.inference_engine.description") ||
				"Manage llama.cpp binary updates"
			}
			defaultOpen={true}
		>
			<div className="bg-black/20 rounded-lg p-4 border border-white/5">
				<div className="flex items-center justify-between">
					<div>
						<div className="text-sm text-gray-400 mb-1">
							{t("settings.sections.general.inference_engine.current_version") || "Current Version"}
						</div>
						<div className="font-mono text-green-400">
							{updateInfo?.current_version || "Unknown"}
						</div>
					</div>

					<div className="flex gap-3 items-center">
						{updateInfo?.has_update && (
							<div className="text-right">
								<div className="text-xs text-yellow-400">
									{t("settings.sections.general.inference_engine.new_available") ||
										"New Version Available"}
								</div>
								<div className="font-mono text-white text-sm">{updateInfo.latest_version}</div>
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
									? t("settings.sections.general.inference_engine.checking") || "Checking..."
									: t("settings.sections.general.inference_engine.check_updates") ||
										"Check for Updates"}
							</button>
						)}
					</div>
				</div>
			</div>
		</CollapsibleSection>
	);
};

export default OtherSettings;
