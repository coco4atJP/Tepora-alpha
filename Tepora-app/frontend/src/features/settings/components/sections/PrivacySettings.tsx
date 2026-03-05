import { AlertTriangle, Eye, Loader2, Plane, Shield } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { Config } from "../../../../context/SettingsContext";
import { useMcpPolicy } from "../../../../hooks/useMcp";
import { useSettings } from "../../../../hooks/useSettings";
import { FormGroup, FormInput, FormList, FormSwitch, SettingsSection } from "../SettingsComponents";

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

interface PrivacySettingsProps {
	privacyConfig: Config["privacy"];
	onUpdate: <K extends keyof Config["privacy"]>(field: K, value: Config["privacy"][K]) => void;
}

// Sub-component for Tool Security Policy
const ToolSecurityPolicy: React.FC = () => {
	const { t } = useTranslation();
	const { policy, loading, saving, updatePolicy } = useMcpPolicy();

	return (
		<div className="space-y-4">
			<h3 className="text-lg font-medium text-white flex items-center gap-2">
				{t("settings.mcp.policy.title")}
			</h3>

			{loading ? (
				<div className="flex justify-center p-4">
					<Loader2 className="animate-spin text-gray-400" size={24} />
				</div>
			) : (
				<div className="space-y-4">
					<FormGroup
						label={t("settings.mcp.policy.mode.label")}
						description={t("settings.mcp.policy.mode.description")}
					>
						<select
							value={policy?.policy || "local_only"}
							onChange={(e) => updatePolicy({ policy: e.target.value })}
							disabled={saving}
							className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
						>
							<option value="local_only">{t("settings.mcp.policy.mode.local_only")}</option>
							<option value="stdio_only">{t("settings.mcp.policy.mode.stdio_only")}</option>
							<option value="allowlist">{t("settings.mcp.policy.mode.allowlist")}</option>
						</select>
					</FormGroup>

					<FormGroup
						label={t("settings.mcp.policy.confirmation.label")}
						description={t("settings.mcp.policy.confirmation.description")}
					>
						<FormSwitch
							checked={policy?.require_tool_confirmation ?? true}
							onChange={(val: boolean) => updatePolicy({ require_tool_confirmation: val })}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.mcp.policy.first_use.label", "First-use Confirmation")}
						description={t("settings.mcp.policy.first_use.description", "Show confirmation on first tool invocation per session.")}
					>
						<FormSwitch
							checked={policy?.first_use_confirmation ?? false}
							onChange={(val: boolean) => updatePolicy({ first_use_confirmation: val })}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.mcp.policy.blocked_commands.label", "Blocked Commands")}
						description={t("settings.mcp.policy.blocked_commands.description", "Commands that MCP servers are never allowed to execute.")}
						orientation="vertical"
					>
						<FormList
							items={policy?.blocked_commands ?? []}
							onChange={(items) => updatePolicy({ blocked_commands: items })}
							placeholder={t("settings.mcp.policy.blocked_commands.placeholder", "e.g. rm -rf")}
						/>
					</FormGroup>
				</div>
			)}
		</div>
	);
};

/**
 * Privacy Settings Section.
 * Controls for web search consent and data privacy options.
 */
const PrivacySettings: React.FC<PrivacySettingsProps> = ({ privacyConfig, onUpdate }) => {
	const { t } = useTranslation();
	const { config, updateModelDownload, updateConfigPath } = useSettings();

	const readString = (path: string, fallback = "") => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "string" ? value : fallback;
	};

	const readBoolean = (path: string, fallback = false) => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "boolean" ? value : fallback;
	};

	const readStringList = (path: string) => {
		const value = getPathValue<unknown>(config, path, []);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				title={t("settings.sections.privacy.title")}
				icon={<Shield size={18} />}
				description={t("settings.sections.privacy.description")}
			>
				<div className="space-y-6">
					{/* Isolation Mode (Airplane Mode) */}
					<div className="space-y-4">
						<FormGroup
							label={t("settings.sections.privacy.isolation_mode.label")}
							description={t("settings.sections.privacy.isolation_mode.description")}
							className="delay-0"
						>
							<div className="flex items-center gap-3">
								<Plane className="text-gray-400" size={18} />
								<FormSwitch
									checked={privacyConfig?.isolation_mode ?? false}
									onChange={(value) => onUpdate("isolation_mode", value)}
								/>
							</div>
						</FormGroup>

						{/* Isolation Mode Warning Panel */}
						{privacyConfig?.isolation_mode && (
							<div className="delay-100 settings-form-group bg-blue-500/10 border border-blue-500/30 rounded-xl p-4">
								<div className="flex items-start gap-3">
									<Plane className="text-blue-400 shrink-0 mt-0.5" size={20} />
									<div>
										<h4 className="font-medium text-blue-300 mb-2">
											{t("settings.sections.privacy.isolation_mode.warning_title")}
										</h4>
										<ul className="text-sm text-blue-200/80 space-y-1">
											<li className="flex items-start gap-2">
												<span className="text-red-400">✕</span>
												{t("settings.sections.privacy.isolation_mode.warning_web_search")}
											</li>
											<li className="flex items-start gap-2">
												<span className="text-red-400">✕</span>
												{t("settings.sections.privacy.isolation_mode.warning_mcp")}
											</li>
											<li className="flex items-start gap-2">
												<span className="text-green-400">✓</span>
												{t("settings.sections.privacy.isolation_mode.warning_local")}
											</li>
										</ul>
									</div>
								</div>
							</div>
						)}
					</div>

					<div className="border-t border-white/10 my-4" />

					{/* Web Search Consent */}
					<div className="space-y-4">
						<FormGroup
							label={t("settings.privacy.web_search.label")}
							description={t("settings.privacy.web_search.description")}
							className="delay-0"
						>
							<FormSwitch
								checked={privacyConfig?.allow_web_search ?? false}
								onChange={(value) => onUpdate("allow_web_search", value)}
								disabled={privacyConfig?.isolation_mode ?? false}
							/>
						</FormGroup>

						{/* Data Sharing Explanation Panel */}
						{config?.privacy?.allow_web_search && !privacyConfig?.isolation_mode && (
							<div className="delay-100 settings-form-group bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
								<div className="flex items-start gap-3">
									<AlertTriangle className="text-yellow-400 shrink-0 mt-0.5" size={20} />
									<div>
										<h4 className="font-medium text-yellow-300 mb-2">
											{t("settings.privacy.web_search.warning_title")}
										</h4>
										<ul className="text-sm text-yellow-200/80 space-y-1">
											<li className="flex items-start gap-2">
												<span className="text-yellow-400">•</span>
												{t("settings.privacy.web_search.warning_query")}
											</li>
											<li className="flex items-start gap-2">
												<span className="text-yellow-400">•</span>
												{t("settings.privacy.web_search.warning_api")}
											</li>
										</ul>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* URL Denylist */}
					<FormGroup
						label={t("settings.privacy.url_denylist.label", "URL Deny List")}
						description={t("settings.privacy.url_denylist.description", "Domains or patterns blocked from web fetch. Internal/private ranges are always blocked.")}
						className="delay-100"
						orientation="vertical"
					>
						<FormList
							items={privacyConfig?.url_denylist ?? []}
							onChange={(items) => onUpdate("url_denylist", items)}
							placeholder={t("settings.privacy.url_denylist.placeholder", "e.g. *.example.com")}
						/>
					</FormGroup>

					<div className="border-t border-white/10 my-4" />

					{/* Tool Security Policy */}
					<ToolSecurityPolicy />

					<div className="border-t border-white/10 my-4" />

					{/* PII Redaction */}
					<FormGroup
						label={t("settings.privacy.redact_pii.label")}
						description={t("settings.privacy.redact_pii.description")}
						className="delay-200"
					>
						<div className="flex items-center gap-3">
							<Eye className="text-gray-400" size={18} />
							<FormSwitch
								checked={privacyConfig?.redact_pii ?? true}
								onChange={(value) => onUpdate("redact_pii", value)}
							/>
						</div>
					</FormGroup>
				</div>
			</SettingsSection>

			{/* Model Download Policy */}
			<SettingsSection
				title={t("settings.sections.models.download_policy_title", "Model Download Policy")}
				icon={<Shield size={18} />}
				description={t("settings.sections.models.download_policy_description", "Security controls for downloading models from remote repositories.")}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.fields.require_allowlist.label", "Require Allowlist")}
						description={t("settings.fields.require_allowlist.description", "Only allow downloads from approved repository owners.")}
					>
						<FormSwitch
							checked={config?.model_download?.require_allowlist ?? false}
							onChange={(val) => updateModelDownload("require_allowlist", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.warn_on_unlisted.label", "Warn on Unlisted")}
						description={t("settings.fields.warn_on_unlisted.description", "Show a warning when downloading from an unlisted owner.")}
					>
						<FormSwitch
							checked={config?.model_download?.warn_on_unlisted ?? true}
							onChange={(val) => updateModelDownload("warn_on_unlisted", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.require_revision.label", "Require Revision")}
						description={t("settings.fields.require_revision.description", "Require a specific revision when downloading models.")}
					>
						<FormSwitch
							checked={config?.model_download?.require_revision ?? false}
							onChange={(val) => updateModelDownload("require_revision", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.require_sha256.label", "Require SHA256")}
						description={t("settings.fields.require_sha256.description", "Require SHA256 verification for downloaded models.")}
					>
						<FormSwitch
							checked={config?.model_download?.require_sha256 ?? false}
							onChange={(val) => updateModelDownload("require_sha256", val)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.fields.allow_repo_owners.label", "Allowed Repository Owners")}
						description={t("settings.fields.allow_repo_owners.description", "List of approved repository owners for model downloads.")}
						orientation="vertical"
					>
						<FormList
							items={config?.model_download?.allow_repo_owners ?? []}
							onChange={(items) => updateModelDownload("allow_repo_owners", items)}
							placeholder={t("settings.fields.allow_repo_owners.placeholder", "e.g. TheBloke")}
						/>
					</FormGroup>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.extended.security_title", "Network and Server Security")}
				icon={<Shield size={18} />}
				description={t(
					"settings.sections.extended.security_description",
					"Configure core tool policy, network proxies, certificates, and server origins.",
				)}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.sections.extended.allowed_tools", "Core Tool Allow List")}
						description={t(
							"settings.sections.extended.allowed_tools_desc",
							"Allowed tool names when using allow-list policy.",
						)}
						orientation="vertical"
					>
						<FormList
							items={readStringList("tool_security.allowed_tools")}
							onChange={(items) => updateConfigPath("tool_security.allowed_tools", items)}
							placeholder="native_web_fetch"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.denied_tools", "Core Tool Deny List")}
						description={t(
							"settings.sections.extended.denied_tools_desc",
							"Denied tool names when using deny-list policy.",
						)}
						orientation="vertical"
					>
						<FormList
							items={readStringList("tool_security.denied_tools")}
							onChange={(items) => updateConfigPath("tool_security.denied_tools", items)}
							placeholder="shell"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.tool_confirmation", "Tool Execution Confirmation")}
					>
						<FormSwitch
							checked={readBoolean("tool_security.require_confirmation", true)}
							onChange={(value) => updateConfigPath("tool_security.require_confirmation", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.first_use_confirmation", "First-use Confirmation")}
					>
						<FormSwitch
							checked={readBoolean("tool_security.first_use_confirmation", false)}
							onChange={(value) => updateConfigPath("tool_security.first_use_confirmation", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.dangerous_patterns", "Blocked Command Patterns")}
						description={t(
							"settings.sections.extended.dangerous_patterns_desc",
							"Command patterns that should always be blocked.",
						)}
						orientation="vertical"
					>
						<FormList
							items={readStringList("app.dangerous_patterns")}
							onChange={(items) => updateConfigPath("app.dangerous_patterns", items)}
							placeholder="rm -rf"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.proxy_http", "HTTP Proxy")}
						description={t("settings.sections.extended.proxy_http_desc", "Proxy URL for HTTP requests.")}
					>
						<FormInput
							value={readString("network.proxy.http", "")}
							onChange={(value) => updateConfigPath("network.proxy.http", value)}
							placeholder="http://127.0.0.1:8080"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.proxy_https", "HTTPS Proxy")}
						description={t("settings.sections.extended.proxy_https_desc", "Proxy URL for HTTPS requests.")}
					>
						<FormInput
							value={readString("network.proxy.https", "")}
							onChange={(value) => updateConfigPath("network.proxy.https", value)}
							placeholder="http://127.0.0.1:8080"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.custom_certificate", "Custom Certificate Path")}
						description={t(
							"settings.sections.extended.custom_certificate_desc",
							"Path to custom CA certificate bundle.",
						)}
					>
						<FormInput
							value={readString("network.custom_certificate_path", "")}
							onChange={(value) => updateConfigPath("network.custom_certificate_path", value)}
							placeholder="C:\\certs\\ca.pem"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.server_host", "Server Host")}
						description={t("settings.sections.extended.server_host_desc", "Host binding for backend server.")}
					>
						<FormInput
							value={readString("server.host", "127.0.0.1")}
							onChange={(value) => updateConfigPath("server.host", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.allowed_origins", "Allowed Origins")}
						description={t(
							"settings.sections.extended.allowed_origins_desc",
							"Origins permitted to access the backend.",
						)}
						orientation="vertical"
					>
						<FormList
							items={readStringList("server.allowed_origins")}
							onChange={(items) => updateConfigPath("server.allowed_origins", items)}
							placeholder="https://localhost:1420"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.cors_origins", "CORS Allowed Origins")}
						description={t(
							"settings.sections.extended.cors_origins_desc",
							"Origins allowed by CORS policy.",
						)}
						orientation="vertical"
					>
						<FormList
							items={readStringList("server.cors_allowed_origins")}
							onChange={(items) => updateConfigPath("server.cors_allowed_origins", items)}
							placeholder="https://localhost:1420"
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.sections.extended.ws_origins", "WebSocket Allowed Origins")}
						description={t(
							"settings.sections.extended.ws_origins_desc",
							"Origins allowed for WebSocket connections.",
						)}
						orientation="vertical"
					>
						<FormList
							items={readStringList("server.ws_allowed_origins")}
							onChange={(items) => updateConfigPath("server.ws_allowed_origins", items)}
							placeholder="https://localhost:1420"
						/>
					</FormGroup>
				</div>
			</SettingsSection>
		</div>
	);
};

export default PrivacySettings;
