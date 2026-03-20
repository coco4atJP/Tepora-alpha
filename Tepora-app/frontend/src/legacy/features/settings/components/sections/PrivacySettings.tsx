import { Eye, Loader2, Plane, Shield } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../components/ui/Button";
import { useSettingsConfigActions, useSettingsState } from "../../../../context/SettingsContext";
import { useMcpPolicy } from "../../../../hooks/useMcp";
import type { Config } from "../../../../types/settings";
import type { AuditVerifyResult, PermissionEntry } from "../../../../types";
import { apiClient } from "../../../../utils/api-client";
import { ENDPOINTS } from "../../../../utils/endpoints";
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

interface PrivacySettingsProps {
	privacyConfig: Config["privacy"];
	onUpdate: <K extends keyof Config["privacy"]>(field: K, value: Config["privacy"][K]) => void;
}

type ExtendedPrivacyConfig = PrivacySettingsProps["privacyConfig"] & {
	url_policy_preset?: "strict" | "balanced" | "permissive";
	lockdown?: {
		enabled: boolean;
		updated_at?: string | null;
		reason?: string | null;
	};
};

const formatTimestamp = (value?: string | null) => value ? new Date(value).toLocaleString() : "-";

const PrivacySettings: React.FC<PrivacySettingsProps> = ({ privacyConfig, onUpdate }) => {
	const { t } = useTranslation();
	const { config } = useSettingsState();
	const { updateModelDownload, updateConfigPath, fetchConfig } = useSettingsConfigActions();
	const [permissions, setPermissions] = useState<PermissionEntry[]>([]);
	const [permissionsLoading, setPermissionsLoading] = useState(false);
	const [auditResult, setAuditResult] = useState<AuditVerifyResult | null>(null);
	const [auditLoading, setAuditLoading] = useState(false);
	const privacy = privacyConfig as ExtendedPrivacyConfig;
	const [lockdownReason, setLockdownReason] = useState(privacy.lockdown?.reason ?? "");
	const [lockdownSaving, setLockdownSaving] = useState(false);

	const readString = (path: string, fallback = "") => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "string" ? value : fallback;
	};

	const readBoolean = (path: string, fallback = false) => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "boolean" ? value : fallback;
	};

	const readNumber = (path: string, fallback = 0) => {
		const value = getPathValue<unknown>(config, path, fallback);
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};

	const readStringList = (path: string) => {
		const value = getPathValue<unknown>(config, path, []);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	};

	const refreshPermissions = async () => {
		setPermissionsLoading(true);
		try {
			const data = await apiClient.get<{ permissions: PermissionEntry[] }>(ENDPOINTS.SECURITY.PERMISSIONS);
			setPermissions(data.permissions || []);
		} catch (error) {
			console.error("Failed to load permissions", error);
		} finally {
			setPermissionsLoading(false);
		}
	};

	useEffect(() => {
		void refreshPermissions();
	}, []);

	useEffect(() => {
		setLockdownReason(privacy.lockdown?.reason ?? "");
	}, [privacy.lockdown?.reason]);

	const handleLockdownToggle = async (enabled: boolean) => {
		setLockdownSaving(true);
		try {
			await apiClient.post(ENDPOINTS.SECURITY.LOCKDOWN, {
				enabled,
				reason: lockdownReason.trim() || undefined,
			});
			await fetchConfig();
			await refreshPermissions();
		} catch (error) {
			console.error("Failed to update lockdown", error);
		} finally {
			setLockdownSaving(false);
		}
	};

	const handlePresetChange = (value: string) => {
		updateConfigPath("privacy.url_policy_preset", value);
		if (value === "strict") {
			onUpdate("allow_web_search", false);
		}
		if (value === "permissive") {
			onUpdate("allow_web_search", true);
		}
	};

	const handleVerifyAudit = async () => {
		setAuditLoading(true);
		try {
			const result = await apiClient.get<AuditVerifyResult>(ENDPOINTS.SECURITY.AUDIT_VERIFY);
			setAuditResult(result);
		} catch (error) {
			console.error("Failed to verify audit chain", error);
		} finally {
			setAuditLoading(false);
		}
	};

	const handleRevokePermission = async (entry: PermissionEntry) => {
		try {
			await apiClient.delete(
				ENDPOINTS.SECURITY.PERMISSION(entry.scope_kind, entry.scope_name),
			);
			await refreshPermissions();
		} catch (error) {
			console.error("Failed to revoke permission", error);
		}
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				title={t("settings.sections.privacy.title")}
				icon={<Shield size={18} />}
				description={t("settings.sections.privacy.description")}
			>
				<div className="space-y-6">
					<FormGroup
						label={t("settings.privacy.lockdown.label", "Privacy Lockdown")}
						description={t("settings.privacy.lockdown.description", "Immediately blocks new sends, attachments, MCP, web search, model downloads, backup import/export, memory writes, and frontend log forwarding.")}
						orientation="vertical"
					>
						<div className="space-y-3">
							<div className="flex items-center gap-3">
								<FormSwitch
									checked={privacy?.lockdown?.enabled ?? false}
									onChange={handleLockdownToggle}
									disabled={lockdownSaving}
								/>
								<span className="text-sm text-gray-300">
									{privacy?.lockdown?.enabled
										? t("settings.privacy.lockdown.on", "Lockdown is active")
										: t("settings.privacy.lockdown.off", "Lockdown is inactive")}
								</span>
							</div>
							<FormInput
								value={lockdownReason}
								onChange={(value) => setLockdownReason(String(value))}
								placeholder={t("settings.privacy.lockdown.reason", "Optional reason for this lockdown state")}
							/>
							{privacy?.lockdown?.updated_at && (
								<p className="text-xs text-gray-400">
									{t("settings.privacy.lockdown.updated", "Last changed")}: {formatTimestamp(privacy.lockdown.updated_at)}
								</p>
							)}
						</div>
					</FormGroup>

					<div className="space-y-4">
						<FormGroup
							label={t("settings.sections.privacy.isolation_mode.label")}
							description={t("settings.sections.privacy.isolation_mode.description")}
						>
							<div className="flex items-center gap-3">
								<Plane className="text-gray-400" size={18} />
								<FormSwitch
									checked={privacy?.isolation_mode ?? false}
									onChange={(value) => onUpdate("isolation_mode", value)}
								/>
							</div>
						</FormGroup>

						{privacy?.isolation_mode && (
							<div className="settings-form-group bg-blue-500/10 border border-blue-500/30 rounded-xl p-4">
								<div className="flex items-start gap-3">
									<Plane className="text-blue-400 shrink-0 mt-0.5" size={20} />
									<div>
										<h4 className="font-medium text-blue-300 mb-2">
											{t("settings.sections.privacy.isolation_mode.warning_title")}
										</h4>
										<ul className="text-sm text-blue-200/80 space-y-1">
											<li>{t("settings.sections.privacy.isolation_mode.warning_web_search")}</li>
											<li>{t("settings.sections.privacy.isolation_mode.warning_mcp")}</li>
											<li>{t("settings.sections.privacy.isolation_mode.warning_local")}</li>
										</ul>
									</div>
								</div>
							</div>
						)}
					</div>

					<div className="border-t border-white/10 my-4" />

					<FormGroup
						label={t("settings.privacy.url_policy_preset.label", "URL Policy Preset")}
						description={t("settings.privacy.url_policy_preset.description", "Strict disables web search, balanced keeps current limits, permissive increases fetch limits.")}
					>
						<FormSelect
							value={privacy?.url_policy_preset ?? "balanced"}
							onChange={handlePresetChange}
							options={[
								{ value: "strict", label: t("settings.privacy.url_policy_preset.strict", "Strict") },
								{ value: "balanced", label: t("settings.privacy.url_policy_preset.balanced", "Balanced") },
								{ value: "permissive", label: t("settings.privacy.url_policy_preset.permissive", "Permissive") },
							]}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.privacy.web_search.label")}
						description={t("settings.privacy.web_search.description")}
					>
						<FormSwitch
							checked={privacy?.allow_web_search ?? false}
							onChange={(value) => onUpdate("allow_web_search", value)}
							disabled={(privacy?.isolation_mode ?? false) || privacy?.url_policy_preset === "strict"}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.privacy.url_denylist.label", "URL Deny List")}
						description={t("settings.privacy.url_denylist.description", "Domains or patterns blocked from web fetch. Internal/private ranges are always blocked.")}
						orientation="vertical"
					>
						<FormList
							items={privacy?.url_denylist ?? []}
							onChange={(items) => onUpdate("url_denylist", items)}
							placeholder={t("settings.privacy.url_denylist.placeholder", "e.g. *.example.com")}
						/>
					</FormGroup>

					<div className="border-t border-white/10 my-4" />

					<ToolSecurityPolicy />

					<div className="border-t border-white/10 my-4" />

					<FormGroup
						label={t("settings.privacy.redact_pii.label")}
						description={t("settings.privacy.redact_pii.description")}
					>
						<div className="flex items-center gap-3">
							<Eye className="text-gray-400" size={18} />
							<FormSwitch
								checked={privacy?.redact_pii ?? true}
								onChange={(value) => onUpdate("redact_pii", value)}
							/>
						</div>
					</FormGroup>
				</div>
			</SettingsSection>

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
							checked={config?.model_download?.require_sha256 ?? true}
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
				title={t("settings.security.runtime.title", "Permission Runtime Controls")}
				icon={<Shield size={18} />}
				description={t("settings.security.runtime.description", "Manage permission TTLs, quarantine policy, saved approvals, and audit verification.")}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.security.permissions.ttl", "Default permission TTL (seconds)")}
						description={t("settings.security.permissions.ttl_desc", "Used when a tool or MCP server is allowed until expiry.")}
					>
						<FormInput
							type="number"
							value={readNumber("permissions.default_ttl_seconds", 86400)}
							onChange={(value) => updateConfigPath("permissions.default_ttl_seconds", value)}
							min={60}
							step={60}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.security.quarantine.enabled", "Quarantine policy enabled")}
						description={t("settings.security.quarantine.enabled_desc", "Enforce sandbox requirements for risky MCP transports.")}
					>
						<FormSwitch
							checked={readBoolean("quarantine.enabled", false)}
							onChange={(value) => updateConfigPath("quarantine.enabled", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.security.quarantine.required", "Quarantine required")}
						description={t("settings.security.quarantine.required_desc", "Reject stdio or Wasm execution if no safe runner is available.")}
					>
						<FormSwitch
							checked={readBoolean("quarantine.required", false)}
							onChange={(value) => updateConfigPath("quarantine.required", value)}
						/>
					</FormGroup>

					<FormGroup
						label={t("settings.security.quarantine.transports", "Quarantine transports")}
						description={t("settings.security.quarantine.transports_desc", "Transport names that must satisfy quarantine requirements.")}
						orientation="vertical"
					>
						<FormList
							items={readStringList("quarantine.required_transports")}
							onChange={(items) => updateConfigPath("quarantine.required_transports", items)}
							placeholder="stdio"
						/>
					</FormGroup>

					<div className="border-t border-white/10 pt-4 space-y-3">
						<div className="flex items-center justify-between gap-3">
							<div>
								<h4 className="text-sm font-semibold text-white">
									{t("settings.security.permissions.saved", "Saved permissions")}
								</h4>
								<p className="text-xs text-gray-400">
									{t("settings.security.permissions.saved_desc", "Native tools are stored per tool, MCP approvals are stored per server.")}
								</p>
							</div>
							<Button variant="secondary" onClick={() => void refreshPermissions()} isLoading={permissionsLoading}>
								{t("common.refresh", "Refresh")}
							</Button>
						</div>
						{permissions.length === 0 ? (
							<div className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-gray-400">
								{t("settings.security.permissions.empty", "No saved permissions.")}
							</div>
						) : (
							<div className="space-y-3">
								{permissions.map((entry) => (
									<div key={`${entry.scope_kind}:${entry.scope_name}`} className="rounded-xl border border-white/10 bg-black/20 p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
										<div>
											<div className="text-sm font-medium text-white">
												{entry.scope_name}
											</div>
											<div className="text-xs text-gray-400 mt-1">
												{entry.scope_kind} · {entry.decision} · {t("settings.security.permissions.expires", "expires")}: {formatTimestamp(entry.expires_at)}
											</div>
										</div>
										<Button variant="danger" onClick={() => void handleRevokePermission(entry)}>
											{t("settings.security.permissions.revoke", "Revoke")}
										</Button>
									</div>
								))}
							</div>
						)}
					</div>

					<div className="border-t border-white/10 pt-4 space-y-3">
						<div className="flex items-center justify-between gap-3">
							<div>
								<h4 className="text-sm font-semibold text-white">
									{t("settings.security.audit.title", "Security audit chain")}
								</h4>
								<p className="text-xs text-gray-400">
									{t("settings.security.audit.desc", "Verifies the append-only NDJSON audit hash chain.")}
								</p>
							</div>
							<Button variant="secondary" onClick={() => void handleVerifyAudit()} isLoading={auditLoading}>
								{t("settings.security.audit.verify", "Verify audit log")}
							</Button>
						</div>
						{auditResult && (
							<div className={`rounded-xl p-4 border ${auditResult.valid ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-200" : "bg-red-500/10 border-red-500/20 text-red-200"}`}>
								<div className="font-medium">
									{auditResult.valid
										? t("settings.security.audit.valid", "Audit chain is valid.")
										: t("settings.security.audit.invalid", "Audit chain verification failed.")}
								</div>
								<div className="text-sm mt-1">
									{t("settings.security.audit.entries", "Entries")}: {auditResult.entries}
									{auditResult.failure_at ? ` · ${t("settings.security.audit.failure_at", "Failure at line")}: ${auditResult.failure_at}` : ""}
								</div>
								{auditResult.message && <div className="text-sm mt-1">{auditResult.message}</div>}
							</div>
						)}
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.extended.security_title", "Network and Server Security")}
				icon={<Shield size={18} />}
				description={t("settings.sections.extended.security_description", "Configure core tool policy, network proxies, certificates, and server origins.")}
			>
				<div className="space-y-4">
					<FormGroup
						label={t("settings.sections.extended.allowed_tools", "Core Tool Allow List")}
						description={t("settings.sections.extended.allowed_tools_desc", "Allowed tool names when using allow-list policy.")}
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
						description={t("settings.sections.extended.denied_tools_desc", "Denied tool names when using deny-list policy.")}
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
						description={t("settings.sections.extended.dangerous_patterns_desc", "Command patterns that should always be blocked.")}
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
						description={t("settings.sections.extended.custom_certificate_desc", "Path to custom CA certificate bundle.")}
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
						description={t("settings.sections.extended.allowed_origins_desc", "Origins permitted to access the backend.")}
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
						description={t("settings.sections.extended.cors_origins_desc", "Origins allowed by CORS policy.")}
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
						description={t("settings.sections.extended.ws_origins_desc", "Origins allowed for WebSocket connections.")}
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

