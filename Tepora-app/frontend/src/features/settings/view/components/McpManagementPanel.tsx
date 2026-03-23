import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../shared/ui/Button";
import { Modal } from "../../../../shared/ui/Modal";
import { Select } from "../../../../shared/ui/Select";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";
import {
	useDeleteMcpServerMutation,
	useMcpConfigQuery,
	useMcpInstallConfirmMutation,
	useMcpInstallPreviewMutation,
	useMcpStatusQuery,
	useMcpStoreQuery,
	useSaveMcpConfigMutation,
	useToggleMcpServerMutation,
} from "../../model/queries";
import type {
	McpServerConfig,
	McpStoreServer,
} from "../../../../shared/contracts";

function parseEnvText(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const separatorIndex = line.indexOf("=");
		if (separatorIndex <= 0) {
			throw new Error("Use KEY=VALUE format for environment variables.");
		}
		const key = line.slice(0, separatorIndex).trim();
		const value = line.slice(separatorIndex + 1).trim();
		if (!key) {
			throw new Error("Use KEY=VALUE format for environment variables.");
		}
		env[key] = value;
	}

	return env;
}

function formatCommandPreview(config: McpServerConfig) {
	return [config.command, ...config.args].join(" ").trim();
}

function formatTimestamp(value?: string | null) {
	if (!value) {
		return "-";
	}

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function statusTone(status?: string) {
	switch (status) {
		case "connected":
			return "border-emerald-500/20 bg-emerald-500/10 text-emerald-200";
		case "connecting":
			return "border-amber-500/20 bg-amber-500/10 text-amber-200";
		case "error":
			return "border-red-500/20 bg-red-500/10 text-red-200";
		default:
			return "border-primary/10 bg-primary/5 text-text-muted";
	}
}

export function McpManagementPanel() {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const configQuery = useMcpConfigQuery();
	const statusQuery = useMcpStatusQuery();
	const saveConfig = useSaveMcpConfigMutation();
	const toggleServer = useToggleMcpServerMutation();
	const deleteServer = useDeleteMcpServerMutation();
	const previewInstall = useMcpInstallPreviewMutation();
	const confirmInstall = useMcpInstallConfirmMutation();
	const [showStore, setShowStore] = useState(false);
	const [detailTarget, setDetailTarget] = useState<{
		name: string;
		config: McpServerConfig;
	} | null>(null);
	const [draftCommand, setDraftCommand] = useState("");
	const [draftArgs, setDraftArgs] = useState("");
	const [draftEnv, setDraftEnv] = useState("");
	const [draftEnabled, setDraftEnabled] = useState(false);
	const [draftDisplayName, setDraftDisplayName] = useState("");
	const [draftDescription, setDraftDescription] = useState("");
	const [detailError, setDetailError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const serverEntries = useMemo(() => {
		return Object.entries(configQuery.data?.mcpServers ?? {})
			.map(([name, config]) => ({
				name,
				config,
				status: statusQuery.data?.servers?.[name],
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
	}, [configQuery.data?.mcpServers, statusQuery.data?.servers]);

	const openDetail = (name: string, config: McpServerConfig) => {
		setDetailTarget({ name, config });
		setDraftCommand(config.command ?? "");
		setDraftArgs((config.args ?? []).join("\n"));
		setDraftEnv(
			Object.entries(config.env ?? {})
				.map(([key, value]) => `${key}=${value}`)
				.join("\n"),
		);
		setDraftEnabled(Boolean(config.enabled));
		setDraftDisplayName(config.metadata?.name ?? "");
		setDraftDescription(config.metadata?.description ?? "");
		setDetailError(null);
	};

	const saveDetail = async () => {
		if (!detailTarget) {
			return;
		}
		if (!draftCommand.trim()) {
			setDetailError("Command is required.");
			return;
		}

		try {
			const env = parseEnvText(draftEnv);
			const args = draftArgs
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			const currentServers = configQuery.data?.mcpServers ?? {};
			await saveConfig.mutateAsync({
				...currentServers,
				[detailTarget.name]: {
					...detailTarget.config,
					command: draftCommand.trim(),
					args,
					env,
					enabled: draftEnabled,
					metadata:
						draftDisplayName.trim() || draftDescription.trim()
							? {
									name: draftDisplayName.trim() || undefined,
									description: draftDescription.trim() || undefined,
							  }
							: null,
				},
			});
			setDetailTarget(null);
		} catch (error) {
			setDetailError(error instanceof Error ? error.message : "Failed to save MCP config.");
		}
	};

	return (
		<div className="flex flex-col gap-8">
			<SettingsSectionGroup title={t("v2.settings.mcp", "MCP")}>
				<SettingsRow
					label={t("v2.settings.mcpConfigPath", "MCP Config Path")}
					description={t(
						"v2.settings.mcpConfigPathDescription",
						"Path to the MCP configuration file used by the backend",
					)}
				>
					<div className="w-full max-w-2xl">
						<TextField
							value={editor.readString("app.mcp_config_path", "")}
							onChange={(event) =>
								editor.updateField("app.mcp_config_path", event.target.value)
							}
							placeholder="/absolute/path/to/mcp_tools_config.json"
						/>
					</div>
				</SettingsRow>
				<div className="flex flex-wrap gap-2">
					<Button type="button" onClick={() => setShowStore(true)}>
						Open MCP Store
					</Button>
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							void configQuery.refetch();
							void statusQuery.refetch();
						}}
					>
						Refresh
					</Button>
				</div>
			</SettingsSectionGroup>

			<SettingsSectionGroup
				title={t("v2.settings.registeredServers", "Registered Servers")}
			>
				{actionError ? (
					<div className="mb-4 rounded-[24px] border border-red-500/20 bg-red-500/10 px-6 py-5 text-sm text-red-200">
						{actionError}
					</div>
				) : null}
				<div className="grid gap-4">
					{serverEntries.length === 0 ? (
						<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm text-text-muted">
							No MCP servers are configured yet.
						</div>
					) : null}

					{serverEntries.map((entry) => (
						<div
							key={entry.name}
							className="rounded-[24px] border border-primary/10 bg-white/55 p-5"
						>
							<div className="flex flex-wrap items-start justify-between gap-4">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-3">
										<div className="text-base font-medium text-text-main">
											{entry.config.metadata?.name || entry.name}
										</div>
										<div
											className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.16em] ${statusTone(entry.status?.status)}`}
										>
											{entry.status?.status ?? "disconnected"}
										</div>
									</div>
									<div className="mt-2 text-sm text-text-muted">
										{entry.config.metadata?.description || "No description"}
									</div>
									<div className="mt-3 font-mono text-xs text-text-muted">
										{formatCommandPreview(entry.config)}
									</div>
									<div className="mt-3 text-xs uppercase tracking-[0.16em] text-text-muted">
										Tools: {entry.status?.tools_count ?? 0} | Last connected:{" "}
										{formatTimestamp(entry.status?.last_connected)}
									</div>
									{entry.status?.error_message ? (
										<div className="mt-2 text-sm text-red-300">
											{entry.status.error_message}
										</div>
									) : null}
								</div>
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="ghost"
										onClick={() => {
											setActionError(null);
											openDetail(entry.name, entry.config);
										}}
									>
										Details
									</Button>
									<Button
										type="button"
										variant="ghost"
										onClick={async () => {
											try {
												setActionError(null);
												await toggleServer.mutateAsync({
												serverName: entry.name,
												enabled: !entry.config.enabled,
												});
											} catch (error) {
												setActionError(
													error instanceof Error
														? error.message
														: "Failed to toggle MCP server.",
												);
											}
										}}
										disabled={toggleServer.isPending}
									>
										{entry.config.enabled ? "Disable" : "Enable"}
									</Button>
									<Button
										type="button"
										variant="ghost"
										onClick={() => {
											if (
												window.confirm(
													`Delete MCP server '${entry.name}'?`,
												)
											) {
												void (async () => {
													try {
														setActionError(null);
														await deleteServer.mutateAsync(entry.name);
													} catch (error) {
														setActionError(
															error instanceof Error
																? error.message
																: "Failed to delete MCP server.",
														);
													}
												})();
											}
										}}
										disabled={deleteServer.isPending}
									>
										Delete
									</Button>
								</div>
							</div>
						</div>
					))}
				</div>
			</SettingsSectionGroup>

			<Modal
				isOpen={Boolean(detailTarget)}
				onClose={() => setDetailTarget(null)}
				title={detailTarget ? `MCP Server: ${detailTarget.name}` : undefined}
				size="lg"
			>
				<div className="space-y-4">
					{detailError ? (
						<div className="rounded-[20px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
							{detailError}
						</div>
					) : null}
					<div className="grid gap-4 md:grid-cols-2">
						<div>
							<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
								Display Name
							</div>
							<TextField
								value={draftDisplayName}
								onChange={(event) => setDraftDisplayName(event.target.value)}
								placeholder="Friendly name"
							/>
						</div>
						<div className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2">
							<span className="text-sm text-text-main">Enabled</span>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setDraftEnabled((current) => !current)}
							>
								{draftEnabled ? "Enabled" : "Disabled"}
							</Button>
						</div>
					</div>
					<div>
						<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
							Description
						</div>
						<TextField
							value={draftDescription}
							onChange={(event) => setDraftDescription(event.target.value)}
							placeholder="What this server does"
						/>
					</div>
					<div>
						<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
							Command
						</div>
						<TextField
							value={draftCommand}
							onChange={(event) => setDraftCommand(event.target.value)}
							placeholder="npx"
						/>
					</div>
					<div>
						<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
							Args
						</div>
						<textarea
							value={draftArgs}
							onChange={(event) => setDraftArgs(event.target.value)}
							className="min-h-[120px] w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
							placeholder={"@modelcontextprotocol/server-filesystem\n/path/to/root"}
							spellCheck={false}
						/>
					</div>
					<div>
						<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
							Environment Variables
						</div>
						<textarea
							value={draftEnv}
							onChange={(event) => setDraftEnv(event.target.value)}
							className="min-h-[140px] w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
							placeholder={"API_KEY=...\nLOG_LEVEL=info"}
							spellCheck={false}
						/>
					</div>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={() => setDetailTarget(null)}>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={() => void saveDetail()}
							disabled={saveConfig.isPending}
						>
							{saveConfig.isPending ? "Saving..." : "Save"}
						</Button>
					</div>
				</div>
			</Modal>

			<McpStoreModal
				isOpen={showStore}
				onClose={() => setShowStore(false)}
				previewInstall={previewInstall}
				confirmInstall={confirmInstall}
			/>
		</div>
	);
}

function McpStoreModal({
	isOpen,
	onClose,
	previewInstall,
	confirmInstall,
}: {
	isOpen: boolean;
	onClose: () => void;
	previewInstall: ReturnType<typeof useMcpInstallPreviewMutation>;
	confirmInstall: ReturnType<typeof useMcpInstallConfirmMutation>;
}) {
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
	const [runtime, setRuntime] = useState("");
	const [envValues, setEnvValues] = useState<Record<string, string>>({});
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [previewData, setPreviewData] = useState<Awaited<
		ReturnType<typeof previewInstall.mutateAsync>
	> | null>(null);
	const storeQuery = useMcpStoreQuery({
		search: searchQuery.trim() || undefined,
		page: 1,
		pageSize: 50,
		enabled: isOpen,
	});

	const selectedServer = useMemo<McpStoreServer | null>(() => {
		return (
			storeQuery.data?.servers.find((server) => server.id === selectedServerId) ?? null
		);
	}, [selectedServerId, storeQuery.data?.servers]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}

		const firstServerId = storeQuery.data?.servers[0]?.id ?? null;
		if (!selectedServerId || !selectedServer) {
			setSelectedServerId(firstServerId);
		}
	}, [isOpen, selectedServer, selectedServerId, storeQuery.data?.servers]);

	useEffect(() => {
		if (!selectedServer) {
			return;
		}

		setRuntime(selectedServer.packages[0]?.runtimeHint ?? "");
		setEnvValues(
			Object.fromEntries(
				selectedServer.environmentVariables.map((envVar) => [
					envVar.name,
					envVar.default ?? "",
				]),
			),
		);
		setPreviewData(null);
		setPreviewError(null);
	}, [selectedServer]);

	const requestPreview = async () => {
		if (!selectedServer) {
			return;
		}
		try {
			setPreviewError(null);
			setActionError(null);
			const result = await previewInstall.mutateAsync({
				server_id: selectedServer.id,
				runtime: runtime || undefined,
				env_values: envValues,
				server_name: selectedServer.name,
			});
			setPreviewData(result);
		} catch (error) {
			setPreviewError(
				error instanceof Error ? error.message : "Failed to preview MCP install.",
			);
		}
	};

	const confirmPreview = async () => {
		if (!previewData) {
			return;
		}

		try {
			setActionError(null);
			await confirmInstall.mutateAsync(previewData.consent_id);
			onClose();
		} catch (error) {
			setActionError(
				error instanceof Error ? error.message : "Failed to install MCP server.",
			);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="MCP Store" size="xl">
			<div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
				<div className="space-y-4">
					<TextField
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						placeholder="Search MCP servers..."
					/>
					<div className="space-y-3">
						{storeQuery.data?.servers.map((server) => {
							const selected = selectedServerId === server.id;
							return (
								<button
									type="button"
									key={server.id}
									onClick={() => setSelectedServerId(server.id)}
									className={`w-full rounded-[20px] border p-4 text-left transition-colors ${
										selected
											? "border-primary/20 bg-primary/8"
											: "border-primary/10 bg-white/55 hover:bg-white/70"
									}`}
								>
									<div className="text-sm font-medium text-text-main">
										{server.title || server.name}
									</div>
									<div className="mt-2 text-sm leading-6 text-text-muted">
										{server.description || "No description"}
									</div>
								</button>
							);
						})}
						{storeQuery.data?.servers.length === 0 ? (
							<div className="rounded-[20px] border border-primary/10 bg-white/55 px-5 py-4 text-sm text-text-muted">
								No store servers found.
							</div>
						) : null}
					</div>
				</div>

				<div className="space-y-4">
					{actionError ? (
						<div className="rounded-[20px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
							{actionError}
						</div>
					) : null}
					{selectedServer ? (
						<>
							<div className="rounded-[24px] border border-primary/10 bg-white/55 p-5">
								<div className="text-lg font-medium text-text-main">
									{selectedServer.title || selectedServer.name}
								</div>
								<div className="mt-2 text-sm leading-7 text-text-muted">
									{selectedServer.description || "No description"}
								</div>
								<div className="mt-4 grid gap-4 md:grid-cols-2">
									<div>
										<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
											Runtime
										</div>
										<Select
											value={runtime}
											onChange={(event) => setRuntime(event.target.value)}
										>
											{selectedServer.packages.map((pkg) => (
												<option
													key={`${pkg.name}-${pkg.runtimeHint ?? "default"}`}
													value={pkg.runtimeHint ?? ""}
												>
													{pkg.name}
													{pkg.runtimeHint ? ` (${pkg.runtimeHint})` : ""}
												</option>
											))}
										</Select>
									</div>
									<div>
										<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
											Vendor
										</div>
										<div className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-main">
											{selectedServer.vendor || "-"}
										</div>
									</div>
								</div>

								{selectedServer.environmentVariables.length > 0 ? (
									<div className="mt-5 space-y-4">
										<div className="text-sm font-medium text-text-main">
											Environment Variables
										</div>
										{selectedServer.environmentVariables.map((envVar) => (
											<div key={envVar.name}>
												<div className="mb-2 text-xs uppercase tracking-[0.16em] text-text-muted">
													{envVar.name}
													{envVar.isRequired ? " (required)" : ""}
												</div>
												<TextField
													type={envVar.isSecret ? "password" : "text"}
													value={envValues[envVar.name] ?? ""}
													onChange={(event) =>
														setEnvValues((current) => ({
															...current,
															[envVar.name]: event.target.value,
														}))
													}
													placeholder={envVar.description || envVar.default || ""}
												/>
											</div>
										))}
									</div>
								) : null}
							</div>

							{previewError ? (
								<div className="rounded-[20px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
									{previewError}
								</div>
							) : null}

							{previewData ? (
								<div className="rounded-[24px] border border-primary/10 bg-white/55 p-5">
									<div className="text-sm font-medium text-text-main">Install Preview</div>
									<div className="mt-3 rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-text-main">
										{previewData.full_command}
									</div>
									{previewData.warnings.length > 0 ? (
										<div className="mt-4 space-y-2">
											{previewData.warnings.map((warning) => (
												<div
													key={warning}
													className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
												>
													{warning}
												</div>
											))}
										</div>
									) : null}
									<div className="mt-4 flex justify-end gap-2">
										<Button type="button" variant="ghost" onClick={() => setPreviewData(null)}>
											Clear Preview
										</Button>
										<Button
											type="button"
											onClick={() => void confirmPreview()}
											disabled={confirmInstall.isPending}
										>
											{confirmInstall.isPending ? "Installing..." : "Confirm Install"}
										</Button>
									</div>
								</div>
							) : (
								<div className="flex justify-end">
									<Button
										type="button"
										onClick={() => void requestPreview()}
										disabled={!selectedServer || previewInstall.isPending}
									>
										{previewInstall.isPending ? "Preparing..." : "Preview Install"}
									</Button>
								</div>
							)}
						</>
					) : (
						<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm text-text-muted">
							Select a server from the registry to inspect installation details.
						</div>
					)}
				</div>
			</div>
		</Modal>
	);
}
