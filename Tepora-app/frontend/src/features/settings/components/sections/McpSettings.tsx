import {
	AlertCircle,
	CheckCircle,
	Database,
	Loader2,
	Plus,
	Power,
	RefreshCw,
	Shield,
	Trash2,
	XCircle,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type McpServerStatus, useMcpPolicy, useMcpServers } from "../../../../hooks/useMcp";
import { useSettings } from "../../../../hooks/useSettings";
import { FormGroup, FormInput, FormSwitch, SettingsSection } from "../SettingsComponents";
import { McpStoreModal } from "../subcomponents/McpStoreModal";

/**
 * MCP Settings Section.
 * Dynamic management of MCP servers with status indicators and store integration.
 */
const McpSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, updateApp } = useSettings();
	const { policy, loading: policyLoading, saving: policySaving, updatePolicy } = useMcpPolicy();
	const { servers, status, loading, error, refresh, toggleServer, removeServer } = useMcpServers();
	const [showStore, setShowStore] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

	const serverList = useMemo(() => {
		return Object.entries(servers).map(([name, config]) => ({
			name,
			config,
			status: status[name],
		}));
	}, [servers, status]);

	const getStatusIcon = (serverStatus?: McpServerStatus) => {
		if (!serverStatus) return <XCircle className="text-gray-500" size={16} />;

		switch (serverStatus.status) {
			case "connected":
				return <CheckCircle className="text-green-400" size={16} />;
			case "connecting":
				return <Loader2 className="text-yellow-400 animate-spin" size={16} />;
			case "error":
				return <XCircle className="text-red-400" size={16} />;
			default:
				return <XCircle className="text-gray-500" size={16} />;
		}
	};

	const getStatusText = (serverStatus?: McpServerStatus) => {
		if (!serverStatus) return t("settings.mcp.status.unknown");

		switch (serverStatus.status) {
			case "connected":
				return t("settings.mcp.status.connected", {
					count: serverStatus.tools_count,
				});
			case "connecting":
				return t("settings.mcp.status.connecting");
			case "error":
				return serverStatus.error_message || t("settings.mcp.status.error");
			default:
				return t("settings.mcp.status.disconnected");
		}
	};

	return (
		<SettingsSection
			title={t("settings.sections.mcp.title")}
			icon={<Database size={18} />}
			description={t("settings.sections.mcp.description")}
		>
			{/* Header Actions */}
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={refresh}
						disabled={loading}
						className="flex items-center gap-2 px-3 py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors text-sm"
						aria-label={t("settings.mcp.refresh")}
					>
						<RefreshCw size={16} className={loading ? "animate-spin" : ""} />
						{t("settings.mcp.refresh")}
					</button>
				</div>
				<button
					type="button"
					onClick={() => setShowStore(true)}
					className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 rounded-lg transition-all text-sm font-medium"
				>
					<Plus size={16} />
					{t("settings.mcp.addServer")}
				</button>
			</div>

			{/* Config Path Input */}
			<div className="mb-6">
				<FormGroup
					label={t("settings.mcp.config_path.label")}
					description={t("settings.mcp.config_path.description")}
				>
					<FormInput
						value={config?.app.mcp_config_path || ""}
						onChange={(v) => updateApp("mcp_config_path", v as string)}
						placeholder={t("settings.placeholders.mcp_config")}
					/>
				</FormGroup>
			</div>

			{/* Error Display */}
			{error && (
				<div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 flex items-start gap-3">
					<AlertCircle className="text-red-400 shrink-0 mt-0.5" size={20} />
					<p className="text-red-200 text-sm">{error}</p>
				</div>
			)}

			{/* Policy Settings Panel */}
			<div className="bg-gray-800/50 rounded-xl p-4 mb-6 border border-white/10">
				<div className="flex items-center gap-2 mb-4">
					<Shield size={20} className="text-blue-400" />
					<h3 className="font-medium text-white">{t("settings.mcp.policy.title")}</h3>
				</div>

				{policyLoading ? (
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
								disabled={policySaving}
								className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
							>
								<option value="local_only">{t("settings.mcp.policy.mode.local_only")}</option>
								<option value="stdio_only">{t("settings.mcp.policy.mode.stdio_only")}</option>
								<option value="allowlist">{t("settings.mcp.policy.mode.allowlist")}</option>
							</select>
						</FormGroup>

						<div className="border-t border-white/10 my-2" />

						<FormGroup
							label={t("settings.mcp.policy.confirmation.label")}
							description={t("settings.mcp.policy.confirmation.description")}
						>
							<FormSwitch
								checked={policy?.require_tool_confirmation ?? true}
								onChange={(val: boolean) => updatePolicy({ require_tool_confirmation: val })}
							/>
						</FormGroup>
					</div>
				)}
			</div>

			{/* Server List */}
			<div className="space-y-3">
				{loading && serverList.length === 0 ? (
					<div className="flex items-center justify-center py-12">
						<Loader2 className="animate-spin text-gray-400" size={32} />
					</div>
				) : serverList.length === 0 ? (
					<div className="text-center py-12 text-gray-400">
						<Database size={48} className="mx-auto mb-4 opacity-50" />
						<p className="text-lg font-medium mb-2">{t("settings.mcp.noServers.title")}</p>
						<p className="text-sm">{t("settings.mcp.noServers.description")}</p>
					</div>
				) : (
					serverList.map(({ name, config: serverConfig, status: serverStatus }) => (
						<div
							key={name}
							className="bg-black/20 border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors"
						>
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3 flex-1 min-w-0">
									{/* Status Icon */}
									<div className="shrink-0">{getStatusIcon(serverStatus)}</div>

									{/* Server Info */}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<h4 className="font-medium text-gray-100 truncate">
												{serverConfig.metadata?.name || name}
											</h4>
											{!serverConfig.enabled && (
												<span className="px-2 py-0.5 text-xs bg-gray-700 text-gray-400 rounded">
													{t("settings.mcp.disabled")}
												</span>
											)}
										</div>
										<p className="text-xs text-gray-500 truncate">
											{serverConfig.command} {serverConfig.args.join(" ")}
										</p>
										<p className="text-xs text-gray-400 mt-1">{getStatusText(serverStatus)}</p>
									</div>
								</div>

								{/* Actions */}
								<div className="flex items-center gap-2 ml-4">
									{/* Toggle */}
									<button
										type="button"
										onClick={() => toggleServer(name, !serverConfig.enabled)}
										className={`p-2 rounded-lg transition-colors ${serverConfig.enabled
												? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
												: "bg-gray-700 text-gray-400 hover:bg-gray-600"
											}`}
										aria-label={
											serverConfig.enabled ? t("settings.mcp.disable") : t("settings.mcp.enable")
										}
										title={
											serverConfig.enabled ? t("settings.mcp.disable") : t("settings.mcp.enable")
										}
									>
										<Power size={16} />
									</button>

									{/* Delete */}
									{deleteConfirm === name ? (
										<div className="flex items-center gap-1">
											<button
												type="button"
												onClick={() => {
													removeServer(name);
													setDeleteConfirm(null);
												}}
												className="p-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors"
												aria-label={t("settings.mcp.confirmDelete")}
											>
												<CheckCircle size={16} />
											</button>
											<button
												type="button"
												onClick={() => setDeleteConfirm(null)}
												className="p-2 bg-gray-700 text-gray-400 hover:bg-gray-600 rounded-lg transition-colors"
												aria-label={t("settings.mcp.cancelDelete")}
											>
												<XCircle size={16} />
											</button>
										</div>
									) : (
										<button
											type="button"
											onClick={() => setDeleteConfirm(name)}
											className="p-2 bg-gray-700 text-gray-400 hover:bg-red-500/20 hover:text-red-400 rounded-lg transition-colors"
											aria-label={t("settings.mcp.delete")}
											title={t("settings.mcp.delete")}
										>
											<Trash2 size={16} />
										</button>
									)}
								</div>
							</div>
						</div>
					))
				)}
			</div>

			{/* Store Modal */}
			{showStore && <McpStoreModal onClose={() => setShowStore(false)} onInstalled={refresh} />}
		</SettingsSection>
	);
};

export default McpSettings;
