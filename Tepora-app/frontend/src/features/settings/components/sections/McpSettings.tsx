import {
	AlertCircle,
	CheckCircle,
	Database,
	FileText,
	Loader2,
	Plus,
	Power,
	RefreshCw,
	Trash2,
	XCircle,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../../../components/ui/Modal";
import {
	type McpServerConfig,
	type McpServerStatus,
	useMcpConfig,
	useMcpServers,
} from "../../../../hooks/useMcp";
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
	const { servers, status, loading, error, refresh, toggleServer, removeServer } = useMcpServers();
	const { saveConfig, saving: savingConfig, error: configSaveError } = useMcpConfig();
	const [showStore, setShowStore] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const [detail, setDetail] = useState<{ name: string; config: McpServerConfig } | null>(null);
	const [draftCommand, setDraftCommand] = useState("");
	const [draftArgs, setDraftArgs] = useState("");
	const [draftEnv, setDraftEnv] = useState("");
	const [draftEnabled, setDraftEnabled] = useState(false);
	const [draftError, setDraftError] = useState<string | null>(null);

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
				return <XCircle className="text-red-400 animate-pulse" size={16} />;
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

	const openDetails = (name: string, serverConfig: McpServerConfig) => {
		setDetail({ name, config: serverConfig });
		setDraftCommand(serverConfig.command || "");
		setDraftArgs(serverConfig.args?.join("\n") || "");
		setDraftEnv(
			Object.entries(serverConfig.env || {})
				.map(([key, value]) => `${key}=${value}`)
				.join("\n"),
		);
		setDraftEnabled(Boolean(serverConfig.enabled));
		setDraftError(null);
	};

	const closeDetails = () => {
		setDetail(null);
		setDraftError(null);
	};

	const parseEnvText = (text: string) => {
		const env: Record<string, string> = {};
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		for (const line of lines) {
			const index = line.indexOf("=");
			if (index <= 0) {
				throw new Error(
					t("settings.mcp.details.env_invalid", "Use KEY=VALUE format for env vars."),
				);
			}
			const key = line.slice(0, index).trim();
			const value = line.slice(index + 1).trim();
			if (!key) {
				throw new Error(
					t("settings.mcp.details.env_invalid", "Use KEY=VALUE format for env vars."),
				);
			}
			env[key] = value;
		}
		return env;
	};

	const handleSaveDetails = async () => {
		if (!detail) return;

		if (!draftCommand.trim()) {
			setDraftError(t("settings.mcp.details.command_required", "Command is required."));
			return;
		}

		let env: Record<string, string>;
		try {
			env = parseEnvText(draftEnv);
		} catch (err) {
			setDraftError(err instanceof Error ? err.message : String(err));
			return;
		}

		const args = draftArgs
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

		const nextConfig: Record<string, McpServerConfig> = {
			...servers,
			[detail.name]: {
				...detail.config,
				command: draftCommand.trim(),
				args,
				env,
				enabled: draftEnabled,
			},
		};

		try {
			await saveConfig(nextConfig);
			await refresh();
			closeDetails();
		} catch (err) {
			setDraftError(
				err instanceof Error
					? err.message
					: t("settings.mcp.details.save_failed", "Failed to save config."),
			);
		}
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				title={t("settings.sections.mcp.config_title", "MCP Config")}
				icon={<FileText size={18} />}
				description={t(
					"settings.sections.mcp.config_description",
					"Set the path to your MCP configuration file.",
				)}
			>
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
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.mcp.store_title", "MCP Store")}
				icon={<Plus size={18} />}
				description={t(
					"settings.sections.mcp.store_description",
					"Browse and install MCP servers from the store.",
				)}
			>
				<div className="flex items-center justify-between">
					<p className="text-sm text-gray-400">
						{t(
							"settings.sections.mcp.store_hint",
							"Search, review, and install servers from the official registry.",
						)}
					</p>
					<button
						type="button"
						onClick={() => setShowStore(true)}
						className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-500/80 to-blue-500/80 hover:from-purple-500 hover:to-blue-500 glass-button border-0 rounded-lg transition-all text-sm font-medium shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 active:scale-95"
					>
						<Plus size={16} />
						{t("settings.mcp.addServer")}
					</button>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("settings.sections.mcp.registered_title", "Registered Servers")}
				icon={<Database size={18} />}
				description={t(
					"settings.sections.mcp.registered_description",
					"Manage installed servers and inspect their configuration.",
				)}
			>
				<div className="flex items-center justify-between mb-6">
					<button
						type="button"
						onClick={refresh}
						disabled={loading}
						className="flex items-center gap-2 px-3 py-2 glass-button rounded-lg transition-all hover:bg-white/10 text-sm active:scale-95"
						aria-label={t("settings.mcp.refresh")}
					>
						<RefreshCw size={16} className={loading ? "animate-spin" : ""} />
						{t("settings.mcp.refresh")}
					</button>
				</div>

				{error && (
					<div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 flex items-start gap-3 backdrop-blur-sm">
						<AlertCircle className="text-red-400 shrink-0 mt-0.5 animate-pulse" size={20} />
						<p className="text-red-200 text-sm font-medium">{error}</p>
					</div>
				)}

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
						serverList.map(({ name, config: serverConfig, status: serverStatus }, index) => (
							<div
								key={name}
								className="glass-panel p-4 hover:border-tepora-accent/30 transition-all duration-300 hover:translate-x-1 animate-slide-up"
								style={{ animationDelay: `${index * 50}ms` }}
							>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3 flex-1 min-w-0">
										<div className="shrink-0">{getStatusIcon(serverStatus)}</div>

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
											<p className="text-xs text-gray-400 mt-1">
												{getStatusText(serverStatus)}
											</p>
										</div>
									</div>

									<div className="flex items-center gap-2 ml-4">
										<button
											type="button"
											onClick={() => openDetails(name, serverConfig)}
											className="p-2 bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white rounded-lg transition-colors glass-button"
											aria-label={t("settings.mcp.details.open", "Open details")}
											title={t("settings.mcp.details.open", "Open details")}
										>
											<FileText size={16} />
										</button>

										<button
											type="button"
											onClick={() => toggleServer(name, !serverConfig.enabled)}
											className={`p-2 rounded-lg transition-all glass-button ${serverConfig.enabled
													? "bg-green-500/20 text-green-400 hover:bg-green-500/30 border-green-500/30"
													: "bg-white/5 text-gray-400 hover:bg-white/10"
												}`}
											aria-label={
												serverConfig.enabled
													? t("settings.mcp.disable")
													: t("settings.mcp.enable")
											}
											title={
												serverConfig.enabled
													? t("settings.mcp.disable")
													: t("settings.mcp.enable")
											}
										>
											<Power size={16} />
										</button>

										{deleteConfirm === name ? (
											<div className="flex items-center gap-1">
												<button
													type="button"
													onClick={() => {
														removeServer(name);
														setDeleteConfirm(null);
													}}
													className="p-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors glass-button border-red-500/30"
													aria-label={t("settings.mcp.confirmDelete")}
												>
													<CheckCircle size={16} />
												</button>
												<button
													type="button"
													onClick={() => setDeleteConfirm(null)}
													className="p-2 bg-white/5 text-gray-400 hover:bg-white/10 rounded-lg transition-colors glass-button"
													aria-label={t("settings.mcp.cancelDelete")}
												>
													<XCircle size={16} />
												</button>
											</div>
										) : (
											<button
												type="button"
												onClick={() => setDeleteConfirm(name)}
												className="p-2 bg-white/5 text-gray-400 hover:bg-red-500/20 hover:text-red-400 rounded-lg transition-colors glass-button"
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
			</SettingsSection>

			{showStore && <McpStoreModal onClose={() => setShowStore(false)} onInstalled={refresh} />}

			{detail && (
				<Modal
					isOpen={true}
					onClose={closeDetails}
					title={t("settings.mcp.details.title", {
						name: detail.config.metadata?.name || detail.name,
					})}
					size="lg"
				>
					<div className="space-y-4">
						<div className="text-xs text-gray-500 font-mono">@{detail.name}</div>

						<FormGroup
							label={t("settings.mcp.details.autorun.label", "Auto-run")}
							description={t(
								"settings.mcp.details.autorun.description",
								"Enable this server on application startup.",
							)}
							orientation="horizontal"
						>
							<FormSwitch checked={draftEnabled} onChange={setDraftEnabled} />
						</FormGroup>

						<FormGroup
							label={t("settings.mcp.details.command.label", "Command")}
							description={t(
								"settings.mcp.details.command.description",
								"Executable used to launch the MCP server.",
							)}
						>
							<FormInput
								value={draftCommand}
								onChange={(value) => setDraftCommand(String(value))}
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.mcp.details.args.label", "Arguments")}
							description={t(
								"settings.mcp.details.args.description",
								"One argument per line.",
							)}
						>
							<textarea
								value={draftArgs}
								onChange={(e) => setDraftArgs(e.target.value)}
								className="settings-input w-full h-24 resize-none font-mono text-sm"
								placeholder="--flag\nvalue"
							/>
						</FormGroup>

						<FormGroup
							label={t("settings.mcp.details.env.label", "Environment Variables")}
							description={t(
								"settings.mcp.details.env.description",
								"Use KEY=VALUE format, one per line.",
							)}
						>
							<textarea
								value={draftEnv}
								onChange={(e) => setDraftEnv(e.target.value)}
								className="settings-input w-full h-28 resize-none font-mono text-sm"
								placeholder="API_KEY=..."
							/>
						</FormGroup>

						{(draftError || configSaveError) && (
							<div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
								<p className="text-red-300 text-sm">
									{draftError || configSaveError}
								</p>
							</div>
						)}

						<div className="flex justify-end gap-3 pt-2">
							<button
								type="button"
								onClick={closeDetails}
								className="px-4 py-2 rounded-md hover:bg-white/10 text-sm text-gray-300 transition-colors"
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								onClick={handleSaveDetails}
								disabled={savingConfig}
								className="px-4 py-2 rounded-md bg-gold-500 hover:bg-gold-600 text-black text-sm font-medium transition-colors disabled:opacity-60"
							>
								{savingConfig
									? t("settings.mcp.details.saving", "Saving...")
									: t("common.save")}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</div>
	);
};

export default McpSettings;
