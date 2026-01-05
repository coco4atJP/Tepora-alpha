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
	Trash2,
	XCircle,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type McpServerStatus,
	type McpStoreServer,
	useMcpServers,
	useMcpStore,
} from "../../../hooks/useMcp";
import { useSettings } from "../../../hooks/useSettings";
import Modal from "../../ui/Modal";
import { FormGroup, FormInput, SettingsSection } from "../SettingsComponents";

/**
 * MCP Settings Section.
 * Dynamic management of MCP servers with status indicators and store integration.
 */
const McpSettings: React.FC = () => {
	const { t } = useTranslation();
	const { config, updateApp } = useSettings();
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
					label={
						t("settings.mcp.config_path.label") || "MCP Configuration File"
					}
					description={
						t("settings.mcp.config_path.description") ||
						"Path to the JSON file defining MCP servers."
					}
				>
					<FormInput
						value={config?.app.mcp_config_path || ""}
						onChange={(v) => updateApp("mcp_config_path", v)}
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
					serverList.map(({ name, config, status: serverStatus }) => (
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
												{config.metadata?.name || name}
											</h4>
											{!config.enabled && (
												<span className="px-2 py-0.5 text-xs bg-gray-700 text-gray-400 rounded">
													{t("settings.mcp.disabled")}
												</span>
											)}
										</div>
										<p className="text-xs text-gray-500 truncate">
											{config.command} {config.args.join(" ")}
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
										onClick={() => toggleServer(name, !config.enabled)}
										className={`p-2 rounded-lg transition-colors ${
											config.enabled
												? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
												: "bg-gray-700 text-gray-400 hover:bg-gray-600"
										}`}
										aria-label={
											config.enabled
												? t("settings.mcp.disable")
												: t("settings.mcp.enable")
										}
										title={
											config.enabled
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
												onClick={() => setDeleteConfirm(null)}
												className="p-2 bg-gray-700 text-gray-400 hover:bg-gray-600 rounded-lg transition-colors"
												aria-label={t("settings.mcp.cancelDelete")}
											>
												<XCircle size={16} />
											</button>
										</div>
									) : (
										<button
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
	const { storeServers, loading, error, searchQuery, setSearchQuery, install } =
		useMcpStore();

	const [selectedServer, setSelectedServer] = useState<McpStoreServer | null>(
		null,
	);
	const [step, setStep] = useState<"browse" | "runtime" | "config" | "confirm">(
		"browse",
	);
	const [selectedRuntime, setSelectedRuntime] = useState<string>("");
	const [envValues, setEnvValues] = useState<Record<string, string>>({});
	const [installing, setInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);

	const handleSelectServer = (server: McpStoreServer) => {
		setSelectedServer(server);
		setEnvValues({});

		// Auto-select runtime if only one
		const runtimes = server.packages.map((p) => p.runtimeHint).filter(Boolean);
		if (runtimes.length === 1 && runtimes[0]) {
			setSelectedRuntime(runtimes[0]);
		} else {
			setSelectedRuntime("");
		}

		// Skip to appropriate step
		if (!runtimes.length || runtimes.length === 1) {
			if (server.environmentVariables.length > 0) {
				setStep("config");
			} else {
				setStep("confirm");
			}
		} else {
			setStep("runtime");
		}
	};

	const handleInstall = async () => {
		if (!selectedServer) return;

		setInstalling(true);
		setInstallError(null);

		try {
			await install(selectedServer.id, selectedRuntime, envValues);
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
		if (step === "confirm") {
			if (selectedServer?.environmentVariables.length) {
				setStep("config");
			} else if ((selectedServer?.packages.length || 0) > 1) {
				setStep("runtime");
			} else {
				setStep("browse");
				setSelectedServer(null);
			}
		} else if (step === "config") {
			if ((selectedServer?.packages.length || 0) > 1) {
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
							: t("settings.mcp.store.confirm")
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
							{loading ? (
								<div className="flex items-center justify-center py-12">
									<Loader2 className="animate-spin text-gray-400" size={32} />
								</div>
							) : storeServers.length === 0 ? (
								<div className="text-center py-12 text-gray-400">
									<p>{t("settings.mcp.store.noResults")}</p>
								</div>
							) : (
								storeServers.map((server) => (
									<button
										key={server.id}
										onClick={() => handleSelectServer(server)}
										className="w-full text-left p-4 bg-black/20 hover:bg-black/30 border border-white/5 hover:border-purple-500/50 rounded-xl transition-all"
									>
										<div className="flex items-start justify-between gap-4">
											<div className="flex-1 min-w-0">
												<h4 className="font-medium text-gray-100">
													{server.name}
												</h4>
												{server.description && (
													<p className="text-sm text-gray-400 mt-1 line-clamp-2">
														{server.description}
													</p>
												)}
												<div className="flex items-center gap-2 mt-2">
													{server.packages.map((pkg, i) => (
														<span
															key={i}
															className="px-2 py-0.5 text-xs bg-purple-500/20 text-purple-300 rounded"
														>
															{pkg.runtimeHint || "npx"}
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
								))
							)}
						</div>
					</>
				)}

				{step === "runtime" && selectedServer && (
					<div className="space-y-4">
						<p className="text-gray-400 mb-4">
							{t("settings.mcp.store.runtimeDescription")}
						</p>
						{selectedServer.packages.map((pkg, i) => (
							<button
								key={i}
								onClick={() => {
									setSelectedRuntime(pkg.runtimeHint || "npx");
									if (selectedServer.environmentVariables.length > 0) {
										setStep("config");
									} else {
										setStep("confirm");
									}
								}}
								className={`w-full p-4 text-left border rounded-xl transition-all ${
									selectedRuntime === pkg.runtimeHint
										? "border-purple-500 bg-purple-500/10"
										: "border-white/10 hover:border-white/20 bg-black/20"
								}`}
							>
								<div className="font-medium text-gray-100">
									{pkg.runtimeHint || "npx"}
								</div>
								<div className="text-sm text-gray-400">{pkg.name}</div>
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
								<label className="block text-sm font-medium text-gray-300 mb-1">
									{env.name}
									{env.isRequired && (
										<span className="text-red-400 ml-1">*</span>
									)}
								</label>
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
								onClick={handleBack}
								className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
							>
								{t("common.back")}
							</button>
							<button
								onClick={() => setStep("confirm")}
								className="px-4 py-2 bg-purple-500 hover:bg-purple-600 rounded-lg transition-colors"
							>
								{t("common.next")}
							</button>
						</div>
					</div>
				)}

				{step === "confirm" && selectedServer && (
					<div className="space-y-4">
						<div className="bg-black/30 border border-white/10 rounded-xl p-4">
							<h4 className="font-medium text-gray-100 mb-2">
								{selectedServer.name}
							</h4>
							{selectedServer.description && (
								<p className="text-sm text-gray-400 mb-4">
									{selectedServer.description}
								</p>
							)}
							<div className="text-sm">
								<div className="flex items-center gap-2 text-gray-400">
									<span className="font-medium">Runtime:</span>
									<span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
										{selectedRuntime || "npx"}
									</span>
								</div>
								{Object.keys(envValues).length > 0 && (
									<div className="mt-2 text-gray-400">
										<span className="font-medium">Environment:</span>
										<span className="ml-2">
											{Object.keys(envValues).length} variable(s) configured
										</span>
									</div>
								)}
							</div>
						</div>

						{installError && (
							<div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
								<p className="text-red-300 text-sm">{installError}</p>
							</div>
						)}

						<div className="flex justify-end gap-3 pt-4">
							<button
								onClick={handleBack}
								disabled={installing}
								className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
							>
								{t("common.back")}
							</button>
							<button
								onClick={handleInstall}
								disabled={installing}
								className="flex items-center gap-2 px-6 py-2 bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 rounded-lg transition-all disabled:opacity-50"
							>
								{installing && <Loader2 className="animate-spin" size={16} />}
								{t("settings.mcp.store.install")}
							</button>
						</div>
					</div>
				)}
			</div>
		</Modal>
	);
};

export default McpSettings;
