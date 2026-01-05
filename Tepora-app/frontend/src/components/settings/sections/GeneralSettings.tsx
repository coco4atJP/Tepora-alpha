import {
	Cpu,
	Search as SearchIcon,
	Settings as SettingsIcon,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { getApiBase, getAuthHeaders } from "../../../utils/api";
import {
	FormGroup,
	FormInput,
	FormList,
	FormSelect,
	SettingsSection,
} from "../SettingsComponents";

// Local interface matching the Config structure
interface AppConfig {
	max_input_length: number;
	graph_recursion_limit: number;
	tool_execution_timeout: number;
	dangerous_patterns: string[];
	language: string;
}

interface GeneralSettingsProps {
	config: AppConfig;
	onChange: (field: keyof AppConfig, value: unknown) => void;
	// New props for Tools
	toolsConfig?: {
		google_search_api_key?: string;
		google_search_engine_id?: string;
	};
	onUpdateTools?: (field: any, value: any) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({
	config,
	onChange,
	toolsConfig,
	onUpdateTools,
}) => {
	const { t, i18n } = useTranslation();

	const handleLanguageChange = (lang: string) => {
		onChange("language", lang);
		i18n.changeLanguage(lang);
	};

	return (
		<SettingsSection
			title={t("settings.sections.general.title")}
			icon={<SettingsIcon size={18} />}
			description={t("settings.sections.general.description")}
		>
			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				<FormGroup
					label={t("settings.fields.language.label")}
					description={t("settings.fields.language.description")}
				>
					<FormSelect
						value={config?.language || "en"}
						onChange={handleLanguageChange}
						options={[
							{ value: "en", label: "English" },
							{ value: "ja", label: "日本語" },
						]}
					/>
				</FormGroup>

				<FormGroup
					label={t("settings.fields.max_input_length.label")}
					description={t("settings.fields.max_input_length.description")}
				>
					<FormInput
						type="number"
						value={config?.max_input_length}
						onChange={(v) => onChange("max_input_length", v)}
						min={100}
						max={100000}
					/>
				</FormGroup>

				<FormGroup
					label={t("settings.fields.graph_recursion_limit.label")}
					description={t("settings.fields.graph_recursion_limit.description")}
				>
					<FormInput
						type="number"
						value={config?.graph_recursion_limit}
						onChange={(v) => onChange("graph_recursion_limit", v)}
						min={1}
						max={200}
					/>
				</FormGroup>

				<FormGroup
					label={t("settings.fields.tool_execution_timeout.label")}
					description={t("settings.fields.tool_execution_timeout.description")}
				>
					<FormInput
						type="number"
						value={config?.tool_execution_timeout}
						onChange={(v) => onChange("tool_execution_timeout", v)}
						min={10}
						max={600}
					/>
				</FormGroup>
			</div>

			<div className="mt-6">
				<FormGroup
					label={t("settings.fields.dangerous_patterns.label")}
					description={t("settings.fields.dangerous_patterns.description")}
				>
					<FormList
						items={config?.dangerous_patterns}
						onChange={(items) => onChange("dangerous_patterns", items)}
						placeholder={t("settings.fields.dangerous_patterns.placeholder")}
					/>
				</FormGroup>
			</div>

			{/* External Tools Section */}
			<div className="mt-8 pt-6 border-t border-white/5">
				<div className="flex items-center gap-2 mb-4">
					<SearchIcon size={18} className="text-blue-400" />
					<h3 className="text-lg font-medium text-white">
						{t("settings.sections.general.external_tools") || "External Tools"}
					</h3>
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
					<FormGroup
						label={
							t("settings.fields.google_search_api_key.label") ||
							"Google Search API Key"
						}
						description={
							t("settings.fields.google_search_api_key.description") ||
							"API Key for Google Custom Search JSON API"
						}
					>
						<FormInput
							type="password"
							value={toolsConfig?.google_search_api_key || ""}
							onChange={(v) => onUpdateTools?.("google_search_api_key", v)}
							placeholder="AIza..."
						/>
					</FormGroup>
					<FormGroup
						label={
							t("settings.fields.google_search_engine_id.label") ||
							"Search Engine ID"
						}
						description={
							t("settings.fields.google_search_engine_id.description") ||
							"Custom Search Engine ID (CX)"
						}
					>
						<FormInput
							value={toolsConfig?.google_search_engine_id || ""}
							onChange={(v) => onUpdateTools?.("google_search_engine_id", v)}
							placeholder="0123456789..."
						/>
					</FormGroup>
				</div>
			</div>

			{/* Inference Engine Update Section */}
			<div className="mt-8 pt-6 border-t border-white/5">
				<div className="flex items-center gap-2 mb-4">
					<Cpu size={18} className="text-coffee-400" />
					<h3 className="text-lg font-medium text-white">
						Inference Engine (llama.cpp)
					</h3>
				</div>

				<InferenceEngineUpdate />
			</div>
		</SettingsSection>
	);
};

// Sub-component for Update Logic to keep main component clean
const InferenceEngineUpdate: React.FC = () => {
	const { t } = useTranslation();
	const [checking, setChecking] = React.useState(false);
	const [updateInfo, setUpdateInfo] = React.useState<{
		has_update: boolean;
		current_version: string;
		latest_version?: string;
	} | null>(null);
	const [updating, setUpdating] = React.useState(false);
	const [status, setStatus] = React.useState("");

	const checkUpdate = async () => {
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
	};

	const doUpdate = async () => {
		try {
			setUpdating(true);
			setStatus("Starting update...");
			// Trigger update
			const res = await fetch(`${getApiBase()}/api/setup/binary/update`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...getAuthHeaders() },
				body: JSON.stringify({ variant: "auto" }),
			});
			const data = await res.json();

			if (data.job_id) {
				// Poll progress
				const poll = setInterval(async () => {
					const progRes = await fetch(
						`${getApiBase()}/api/setup/progress?job_id=${data.job_id}`,
						{ headers: { ...getAuthHeaders() } },
					);
					const progData = await progRes.json();
					setStatus(progData.message || `Status: ${progData.status}`);

					if (progData.status === "completed") {
						clearInterval(poll);
						setUpdating(false);
						setStatus("Update completed!");
						checkUpdate(); // Refresh version
					} else if (progData.status === "failed") {
						clearInterval(poll);
						setUpdating(false);
						setStatus(`Update failed: ${progData.message}`);
					}
				}, 1000);
			} else {
				setUpdating(false);
				setStatus("Failed to start update");
			}
		} catch (e) {
			console.error(e);
			setUpdating(false);
			setStatus("Error starting update");
		}
	};

	React.useEffect(() => {
		checkUpdate();
	}, [checkUpdate]);

	return (
		<div className="bg-black/20 rounded-lg p-4 border border-white/5">
			<div className="flex items-center justify-between">
				<div>
					<div className="text-sm text-gray-400 mb-1">Current Version</div>
					<div className="font-mono text-green-400">
						{updateInfo?.current_version || "Unknown"}
					</div>
				</div>

				<div className="flex gap-3 items-center">
					{updateInfo?.has_update && (
						<div className="text-right">
							<div className="text-xs text-yellow-400">
								New Version Available
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
							onClick={doUpdate}
							className="px-4 py-2 bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded-lg text-sm transition-colors flex items-center gap-2"
						>
							<Cpu size={14} />
							{t("common.update_now") || "Update Now"}
						</button>
					) : (
						<button
							onClick={checkUpdate}
							disabled={checking}
							className="px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg text-sm transition-colors"
						>
							{checking ? "Checking..." : "Check for Updates"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
};

export default GeneralSettings;
