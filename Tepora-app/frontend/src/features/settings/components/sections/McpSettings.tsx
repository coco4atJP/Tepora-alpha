import {
	AlertCircle,
	CheckCircle,
	Database,
	ExternalLink,
	Loader2,
	Plus,
	Power,
	RefreshCw,
	Search,
	Shield, // Added Shield import
	Trash2,
	XCircle,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../../../components/ui/Modal";
import {
	type McpInstallPreview,
	type McpServerStatus,
	type McpStoreServer,
	useMcpPolicy, // Added useMcpPolicy import
	useMcpServers,
	useMcpStore,
} from "../../../../hooks/useMcp";
import { useSettings } from "../../../../hooks/useSettings";
import {
	FormGroup,
	FormInput,
	FormSwitch,
	SettingsSection,
} from "../SettingsComponents";

/**
 * MCP Settings Section.
 * Dynamic management of MCP servers with status indicators and store integration.
 */
const McpSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, updateApp } = useSettings();
	const {
		policy,
		loading: policyLoading,
		saving: policySaving,
		updatePolicy,
	} = useMcpPolicy(); // Added useMcpPolicy hook usage
	const {
		servers,
		status,
		loading,
		error,
		refresh,
		toggleServer,
		removeServer,
	} = useMcpServers();
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
						placeholder="config/mcp_tools_config.json"
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
					<h3 className="font-medium text-white">
						{t("settings.mcp.policy.title")}
					</h3>
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
								<option value="local_only">
									{t("settings.mcp.policy.mode.local_only")}
								</option>
								<option value="stdio_only">
									{t("settings.mcp.policy.mode.stdio_only")}
								</option>
								<option value="allowlist">
									{t("settings.mcp.policy.mode.allowlist")}
								</option>
							</select>
						</FormGroup>

						<div className="border-t border-white/10 my-2" />

						<FormGroup
							label={t("settings.mcp.policy.confirmation.label")}
							description={t("settings.mcp.policy.confirmation.description")}
						>
							<FormSwitch
								checked={policy?.require_tool_confirmation ?? true}
								onChange={(val: boolean) =>
									updatePolicy({ require_tool_confirmation: val })
								}
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
						<p className="text-lg font-medium mb-2">
							{t("settings.mcp.noServers.title")}
						</p>
						<p className="text-sm">{t("settings.mcp.noServers.description")}</p>
					</div>
				) : (
					serverList.map(
						({ name, config: serverConfig, status: serverStatus }) => (
							<div
								key={name}
								className="bg-black/20 border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors"
							>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3 flex-1 min-w-0">
										{/* Status Icon */}
										<div className="shrink-0">
											{getStatusIcon(serverStatus)}
										</div>

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
											<p className="text-xs text-gray-400 mt-1">
												{getStatusText(serverStatus)}
											</p>
										</div>
									</div>

									{/* Actions */}
									<div className="flex items-center gap-2 ml-4">
										{/* Toggle */}
										<button
											type="button"
											onClick={() => toggleServer(name, !serverConfig.enabled)}
											className={`p-2 rounded-lg transition-colors ${
												serverConfig.enabled
													? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
													: "bg-gray-700 text-gray-400 hover:bg-gray-600"
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
						),
					)
				)}
			</div>

			{/* Store Modal */}
			{showStore && (
				<McpStoreModal
					onClose={() => setShowStore(false)}
					onInstalled={refresh}
				/>
			)}
		</SettingsSection>
	);
};

// --- Store Modal Component ---

interface McpStoreModalProps {
	onClose: () => void;
	onInstalled: () => void;
}

const McpStoreModal: React.FC<McpStoreModalProps> = ({
	onClose,
	onInstalled,
}) => {
	const { t } = useTranslation();
	const {
		storeServers,
		loading,
		loadingMore,
		error,
		searchQuery,
		setSearchQuery,
		total,
		hasMore,
		loadMore,
		previewInstall,
		confirmInstall,
	} = useMcpStore();

	const [selectedServer, setSelectedServer] = useState<McpStoreServer | null>(
		null,
	);
	const [step, setStep] = useState<
		"browse" | "runtime" | "config" | "preview" | "installing"
	>("browse");
	const [selectedRuntime, setSelectedRuntime] = useState<string>("");
	const [envValues, setEnvValues] = useState<Record<string, string>>({});
	const [installing, setInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
	const [previewData, setPreviewData] = useState<McpInstallPreview | null>(
		null,
	);
	const [previewLoading, setPreviewLoading] = useState(false);

	const handleSelectServer = (server: McpStoreServer) => {
		setSelectedServer(server);
		setEnvValues({});

		// Auto-select runtime if only one
		const runtimes = [
			...new Set(
				server.packages.map((p) => p.runtimeHint || "npx").filter(Boolean),
			),
		];
		if (runtimes.length === 1) {
			setSelectedRuntime(runtimes[0]);
		} else {
			setSelectedRuntime("");
		}

		// Skip to appropriate step
		if (!runtimes.length || runtimes.length === 1) {
			if (server.environmentVariables.length > 0) {
				setStep("config");
			} else {
				// Go directly to preview step
				handlePreview(server, runtimes[0]);
			}
		} else {
			setStep("runtime");
		}
	};

	// Step 1: Get preview with command details and warnings
	const handlePreview = async (server?: McpStoreServer, runtime?: string) => {
		const srv = server || selectedServer;
		const rt = (runtime ?? selectedRuntime) || undefined;
		if (!srv) return;

		setPreviewLoading(true);
		setInstallError(null);

		try {
			const preview = await previewInstall(srv.id, rt, envValues);
			setPreviewData(preview);
			setStep("preview");
		} catch (err) {
			setInstallError(
				err instanceof Error ? err.message : "Failed to preview installation",
			);
		} finally {
			setPreviewLoading(false);
		}
	};

	// Step 2: Confirm installation after user consent
	const handleConfirmInstall = async () => {
		if (!previewData) return;

		setInstalling(true);
		setInstallError(null);

		try {
			await confirmInstall(previewData.consent_id);
			onInstalled();
			onClose();
		} catch (err) {
			setInstallError(
				err instanceof Error ? err.message : "Installation failed",
			);
		} finally {
			setInstalling(false);
		}
	};

	const handleBack = () => {
		const runtimeCount = selectedServer
			? new Set(
					selectedServer.packages
						.map((p) => p.runtimeHint || "npx")
						.filter(Boolean),
				).size
			: 0;

		if (step === "preview") {
			setPreviewData(null);
			if (selectedServer?.environmentVariables.length) {
				setStep("config");
			} else if (runtimeCount > 1) {
				setStep("runtime");
			} else {
				setStep("browse");
				setSelectedServer(null);
			}
		} else if (step === "config") {
			if (runtimeCount > 1) {
				setStep("runtime");
			} else {
				setStep("browse");
				setSelectedServer(null);
			}
		} else if (step === "runtime") {
			setStep("browse");
			setSelectedServer(null);
		}
	};

	return (
		<Modal
			isOpen={true}
			onClose={onClose}
			title={
				step === "browse"
					? t("settings.mcp.store.title")
					: step === "runtime"
						? t("settings.mcp.store.selectRuntime")
						: step === "config"
							? t("settings.mcp.store.configure")
							: step === "preview"
								? t("settings.mcp.store.preview")
								: t("settings.mcp.store.installing")
			}
			size="lg"
		>
			<div className="min-h-[400px]">
				{step === "browse" && (
					<>
						{/* Search */}
						<div className="relative mb-4">
							<Search
								className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
								size={18}
							/>
							<input
								type="text"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder={t("settings.mcp.store.searchPlaceholder")}
								className="w-full pl-10 pr-4 py-3 bg-black/30 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors"
							/>
						</div>

						{/* Error */}
						{error && (
							<div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4">
								<p className="text-red-300 text-sm">{error}</p>
							</div>
						)}

						{/* Server List */}
						<div className="space-y-2 max-h-[400px] overflow-y-auto">
							{loading && storeServers.length === 0 ? (
								<div className="flex items-center justify-center py-12">
									<Loader2 className="animate-spin text-gray-400" size={32} />
								</div>
							) : storeServers.length === 0 ? (
								<div className="text-center py-12 text-gray-400">
									<p>{t("settings.mcp.store.noResults")}</p>
								</div>
							) : (
								<>
									{storeServers.map((server) => (
										<button
											type="button"
											key={server.id}
											onClick={() => handleSelectServer(server)}
											className="w-full text-left p-4 bg-black/20 hover:bg-black/30 border border-white/5 hover:border-purple-500/50 rounded-xl transition-all"
										>
											<div className="flex items-start justify-between gap-4">
												<div className="flex-1 min-w-0">
													<h4 className="font-medium text-gray-100">
														{server.name}
													</h4>
													<p className="text-xs text-gray-500 mt-0.5">
														{server.id}
														{server.version ? ` · v${server.version}` : ""}
													</p>
													{server.description && (
														<p className="text-sm text-gray-400 mt-1 line-clamp-2">
															{server.description}
														</p>
													)}
													<div className="flex items-center gap-2 mt-2">
														{[
															...new Set(
																server.packages
																	.map((p) => p.runtimeHint || "npx")
																	.filter(Boolean),
															),
														].map((rt) => (
															<span
																key={rt}
																className="px-2 py-0.5 text-xs bg-purple-500/20 text-purple-300 rounded"
															>
																{rt}
															</span>
														))}
														{server.vendor && (
															<span className="text-xs text-gray-500">
																by {server.vendor}
															</span>
														)}
													</div>
												</div>
												{server.sourceUrl && (
													<a
														href={server.sourceUrl}
														target="_blank"
														rel="noopener noreferrer"
														onClick={(e) => e.stopPropagation()}
														className="p-2 text-gray-400 hover:text-white"
													>
														<ExternalLink size={16} />
													</a>
												)}
											</div>
										</button>
									))}

									{/* Footer */}
									<div className="pt-3">
										{total > 0 && (
											<p className="text-center text-xs text-gray-500 mb-3">
												{storeServers.length} / {total}
											</p>
										)}
										{hasMore && (
											<button
												type="button"
												onClick={loadMore}
												disabled={loadingMore || loading}
												className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white/5 hover:bg-white/10 rounded-xl transition-colors text-sm disabled:opacity-50"
											>
												{loadingMore && (
													<Loader2 className="animate-spin" size={16} />
												)}
												{t("common.load_more")}
											</button>
										)}
									</div>
								</>
							)}
						</div>
					</>
				)}

				{step === "runtime" && selectedServer && (
					<div className="space-y-4">
						<p className="text-gray-400 mb-4">
							{t("settings.mcp.store.runtimeDescription")}
						</p>
						{[
							...new Set(
								selectedServer.packages
									.map((p) => p.runtimeHint || "npx")
									.filter(Boolean),
							),
						].map((rt) => (
							<button
								type="button"
								key={rt}
								onClick={() => {
									setSelectedRuntime(rt);
									if (selectedServer.environmentVariables.length > 0) {
										setStep("config");
									} else {
										handlePreview(selectedServer, rt);
									}
								}}
								className={`w-full p-4 text-left border rounded-xl transition-all ${
									selectedRuntime === rt
										? "border-purple-500 bg-purple-500/10"
										: "border-white/10 hover:border-white/20 bg-black/20"
								}`}
							>
								<div className="font-medium text-gray-100">{rt}</div>
								<div className="text-sm text-gray-400">
									{selectedServer.packages.find(
										(p) => (p.runtimeHint || "npx") === rt,
									)?.name || selectedServer.id}
								</div>
							</button>
						))}
					</div>
				)}

				{step === "config" && selectedServer && (
					<div className="space-y-4">
						<p className="text-gray-400 mb-4">
							{t("settings.mcp.store.configDescription")}
						</p>
						{selectedServer.environmentVariables.map((env) => (
							<div key={env.name}>
								<div className="block text-sm font-medium text-gray-300 mb-1">
									{env.name}
									{env.isRequired && (
										<span className="text-red-400 ml-1">*</span>
									)}
								</div>
								{env.description && (
									<p className="text-xs text-gray-500 mb-2">
										{env.description}
									</p>
								)}
								<input
									type={env.isSecret ? "password" : "text"}
									value={envValues[env.name] || env.default || ""}
									onChange={(e) =>
										setEnvValues({ ...envValues, [env.name]: e.target.value })
									}
									placeholder={env.default || ""}
									className="w-full px-4 py-2 bg-black/30 border border-white/10 rounded-lg text-white focus:outline-none focus:border-purple-500 transition-colors"
								/>
							</div>
						))}
						<div className="flex justify-end gap-3 pt-4">
							<button
								type="button"
								onClick={handleBack}
								className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
							>
								{t("common.back")}
							</button>
							<button
								type="button"
								onClick={() => handlePreview()}
								disabled={previewLoading}
								className="flex items-center gap-2 px-4 py-2 bg-purple-500 hover:bg-purple-600 rounded-lg transition-colors disabled:opacity-50"
							>
								{previewLoading && (
									<Loader2 className="animate-spin" size={16} />
								)}
								{t("common.next")}
							</button>
						</div>
					</div>
				)}

				{step === "preview" && previewData && (
					<div className="space-y-4">
						{/* Server Info */}
						<div className="bg-black/30 border border-white/10 rounded-xl p-4">
							<h4 className="font-medium text-gray-100 mb-2">
								{previewData.server_name}
							</h4>
							{previewData.description && (
								<p className="text-sm text-gray-400 mb-4">
									{previewData.description}
								</p>
							)}
							<div className="flex items-center gap-2 text-sm text-gray-400">
								<span className="font-medium">Runtime:</span>
								<span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
									{previewData.runtime || "npx"}
								</span>
							</div>
						</div>

						{/* Command Preview */}
						<div className="bg-gray-900 border border-white/10 rounded-xl p-4">
							<h5 className="text-sm font-medium text-gray-300 mb-2">
								{t("settings.mcp.store.commandPreview")}
							</h5>
							<code className="block text-sm text-green-400 font-mono bg-black/50 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
								{previewData.full_command}
							</code>
						</div>

						{/* Security Warnings */}
						{previewData.warnings && previewData.warnings.length > 0 && (
							<div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
								<h5 className="text-sm font-medium text-yellow-300 mb-2 flex items-center gap-2">
									<AlertCircle size={16} />
									{t("settings.mcp.store.securityWarnings")}
								</h5>
								<ul className="text-sm text-yellow-200 space-y-1">
									{previewData.warnings.map((warning, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: warning is string
										<li key={i} className="flex items-start gap-2">
											<span className="text-yellow-400">•</span>
											{warning}
										</li>
									))}
								</ul>
							</div>
						)}

						{/* Environment Variables Preview */}
						{Object.keys(previewData.env).length > 0 && (
							<div className="bg-black/20 border border-white/10 rounded-xl p-4">
								<h5 className="text-sm font-medium text-gray-300 mb-2">
									{t("settings.mcp.store.envVars")}
								</h5>
								<div className="text-xs text-gray-400 space-y-1">
									{Object.entries(previewData.env).map(([key, value]) => (
										<div key={key} className="font-mono">
											<span className="text-gray-300">{key}</span>
											<span className="text-gray-500">: </span>
											<span className="text-gray-400">{value}</span>
										</div>
									))}
								</div>
							</div>
						)}

						{installError && (
							<div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
								<p className="text-red-300 text-sm">{installError}</p>
							</div>
						)}

						<div className="flex justify-end gap-3 pt-4">
							<button
								type="button"
								onClick={handleBack}
								disabled={installing}
								className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
							>
								{t("common.back")}
							</button>
							<button
								type="button"
								onClick={handleConfirmInstall}
								disabled={installing}
								className="flex items-center gap-2 px-6 py-2 bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 rounded-lg transition-all disabled:opacity-50"
							>
								{installing && <Loader2 className="animate-spin" size={16} />}
								{t("settings.mcp.store.confirmInstall")}
							</button>
						</div>
					</div>
				)}
			</div>
		</Modal>
	);
};

export default McpSettings;
