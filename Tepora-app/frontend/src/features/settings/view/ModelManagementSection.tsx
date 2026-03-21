import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Search } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	consentRequiredErrorResponseSchema,
	type SetupModel,
} from "../../../shared/contracts";
import { V2ApiError } from "../../../shared/lib/api-client";
import {
	formatConsentWarnings,
	isSetupJobRunning,
	isTerminalSetupStatus,
	normalizeModelRole,
	useBinaryUpdateInfo,
	useModelUpdateCheck,
	useSetupJobProgress,
	useStartBinaryUpdate,
	useStartModelDownload,
} from "../../../shared/lib/modelManagement";
import { safeParseWithSchema } from "../../../shared/lib/validation";
import {
	AsyncJobStatus,
	Button,
	ConfirmDialog,
	FormField,
	Panel,
	Select,
	TextField,
} from "../../../shared/ui";
import {
	useDeleteSetupModelMutation,
	useV2SetupModelsQuery,
	v2SettingsQueryKeys,
} from "../model/queries";
import { SetupModelCard } from "./components/SetupModelCard";

interface ActiveJobState {
	jobId: string;
	type: "download" | "binary";
}

const EMPTY_FORM = {
	repoId: "",
	filename: "",
	displayName: "",
	revision: "",
	sha256: "",
};

export const ModelManagementSection: React.FC = () => {
	const queryClient = useQueryClient();
	const modelsQuery = useV2SetupModelsQuery();
	const deleteModel = useDeleteSetupModelMutation();
	const binaryInfoQuery = useBinaryUpdateInfo();
	const startDownload = useStartModelDownload();
	const startBinaryUpdate = useStartBinaryUpdate();
	const { updateStatus, isChecking, checkAllModels } = useModelUpdateCheck();
	const [activeRole, setActiveRole] = useState<"all" | "text" | "embedding">("all");
	const [searchTerm, setSearchTerm] = useState("");
	const [isDownloadOpen, setIsDownloadOpen] = useState(false);
	const [form, setForm] = useState(EMPTY_FORM);
	const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [consentRequest, setConsentRequest] = useState<{
		payload: {
			repo_id: string;
			filename: string;
			role: string;
			display_name: string;
			revision?: string;
			sha256?: string;
			acknowledge_warnings?: boolean;
		};
		warnings: string[];
	} | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<SetupModel | null>(null);
	const handledJobsRef = useRef(new Set<string>());

	const progressQuery = useSetupJobProgress(activeJob?.jobId ?? null);

	const normalizedModels =
		modelsQuery.data?.models.map((model) => ({
			...model,
			role: normalizeModelRole(model.role),
		})) ?? [];

	const filteredModels = normalizedModels.filter((model) => {
		if (activeRole !== "all" && model.role !== activeRole) return false;
		if (
			searchTerm &&
			!model.display_name.toLowerCase().includes(searchTerm.toLowerCase()) &&
			!model.filename?.toLowerCase().includes(searchTerm.toLowerCase())
		) {
			return false;
		}
		return true;
	});

	const remoteModels = normalizedModels.filter((model) => Boolean(model.repo_id));
	const progressSnapshot = useMemo(
		() =>
			activeJob && progressQuery.data
				? progressQuery.data
				: activeJob
					? {
							status: "pending",
							progress: 0,
							message:
								activeJob.type === "binary"
									? "Preparing binary update..."
									: "Preparing download...",
						}
					: null,
		[activeJob, progressQuery.data],
	);
	const isBusy = isSetupJobRunning(progressSnapshot?.status);

	useEffect(() => {
		if (!activeJob || !progressSnapshot || !isTerminalSetupStatus(progressSnapshot.status)) {
			return;
		}
		if (handledJobsRef.current.has(activeJob.jobId)) {
			return;
		}

		handledJobsRef.current.add(activeJob.jobId);
		setErrorMessage(
			progressSnapshot.status === "failed" ? progressSnapshot.message : null,
		);

		if (activeJob.type === "download" && progressSnapshot.status === "completed") {
			setForm(EMPTY_FORM);
		}

		void queryClient.invalidateQueries({
			queryKey: v2SettingsQueryKeys.models(),
		});
		void queryClient.invalidateQueries({
			queryKey: ["v2", "setup", "binary-update-info"],
		});
	}, [activeJob, progressSnapshot, queryClient]);

	const startDownloadFlow = async (payload: {
		repo_id: string;
		filename: string;
		role: string;
		display_name: string;
		revision?: string;
		sha256?: string;
		acknowledge_warnings?: boolean;
	}) => {
		try {
			setErrorMessage(null);
			const result = await startDownload.mutateAsync(payload);
			setActiveJob({
				jobId: result.job_id,
				type: "download",
			});
		} catch (error) {
			if (error instanceof V2ApiError && error.status === 409) {
				const parsed = safeParseWithSchema(
					consentRequiredErrorResponseSchema,
					error.data,
					"v2.models.download.consent",
				);
				if (parsed.success) {
					setConsentRequest({
						payload,
						warnings: formatConsentWarnings(parsed.data.warnings),
					});
					return;
				}
			}
			setErrorMessage(error instanceof Error ? error.message : "Failed to start download");
		}
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!form.repoId.trim() || !form.filename.trim()) {
			setErrorMessage("Repository and filename are required.");
			return;
		}

		await startDownloadFlow({
			repo_id: form.repoId.trim(),
			filename: form.filename.trim(),
			role: activeRole === "all" ? "text" : activeRole,
			display_name: form.displayName.trim() || form.filename.trim(),
			revision: form.revision.trim() || undefined,
			sha256: form.sha256.trim() || undefined,
			acknowledge_warnings: false,
		});
	};

	const handleDelete = async () => {
		if (!deleteTarget) {
			return;
		}

		try {
			setErrorMessage(null);
			await deleteModel.mutateAsync(deleteTarget.id);
			setDeleteTarget(null);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Failed to delete model");
		}
	};

	return (
		<div className="flex flex-col gap-6 w-full mx-auto">
			{/* Controls Bar */}
			<div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 justify-between bg-surface/30 p-2 rounded-2xl border border-border/40 pb-2">
				{/* Search Bar */}
				<div className="relative w-full sm:max-w-xs xl:max-w-md shrink-0">
					<Search
						className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted opacity-60"
						size={16}
					/>
					<input
						type="text"
						placeholder="Search models..."
						value={searchTerm}
						onChange={(e) => setSearchTerm(e.target.value)}
						className="block w-full font-sans text-sm text-text-main bg-surface/60 border border-border/50 rounded-xl pl-10 pr-4 py-2.5 transition-colors duration-200 ease-out hover:border-primary/50 focus:bg-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary placeholder:text-text-muted/60"
					/>
				</div>

				<div className="flex flex-wrap items-center gap-3">
					{/* Filter Tabs */}
					<div className="flex items-center gap-1 p-1 bg-surface/50 border border-border/50 rounded-xl overflow-x-auto no-scrollbar shrink-0">
						{(["all", "text", "embedding"] as const).map((role) => (
							<button
								key={role}
								onClick={() => setActiveRole(role)}
								className={`
									px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all whitespace-nowrap
									${
										activeRole === role
											? "bg-primary/10 text-primary border border-primary/20 shadow-sm"
											: "text-text-muted hover:text-text-main hover:bg-surface/50 border border-transparent"
									}
								`}
							>
								{role === "all" ? "All" : role === "text" ? "Text" : "Embedding"}
							</button>
						))}
					</div>

					<Button
						type="button"
						variant="secondary"
						onClick={() => void checkAllModels(remoteModels)}
						disabled={isChecking || remoteModels.length === 0 || isBusy}
						className="shrink-0 h-[34px] text-xs font-bold uppercase tracking-widest rounded-xl border border-secondary/30"
					>
						{isChecking ? "Checking..." : "Check Updates"}
					</Button>
				</div>
			</div>

			{progressSnapshot ? (
				<AsyncJobStatus
					status={progressSnapshot.status}
					progress={progressSnapshot.progress}
					message={progressSnapshot.message}
				/>
			) : null}

			{errorMessage ? (
				<div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
					{errorMessage}
				</div>
			) : null}

			{/* Download Model Form Collapsible */}
			<Panel variant="glass" className="overflow-hidden">
				<button
					onClick={() => setIsDownloadOpen(!isDownloadOpen)}
					className="w-full p-5 flex items-center justify-between hover:bg-black/5 dark:hover:bg-white/[0.02] transition-colors focus:outline-none focus:bg-black/5 dark:focus:bg-white/[0.02]"
				>
					<div className="text-left flex items-center gap-4">
						<div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
							<Download size={18} className="text-primary" />
						</div>
						<div>
							<h3 className="font-serif text-[17px] font-semibold tracking-wide text-text-main">
								Download Models
							</h3>
							<p className="mt-1 text-xs text-text-muted tracking-wide">
								Add a remote model from Hugging Face with explicit revision and SHA.
							</p>
						</div>
					</div>
					{isDownloadOpen ? (
						<ChevronDown size={20} className="text-text-muted" />
					) : (
						<ChevronRight size={20} className="text-text-muted" />
					)}
				</button>

				{isDownloadOpen && (
					<div className="p-5 pt-0 border-t border-border/50 animate-in fade-in duration-300">
						<form className="grid gap-5 md:grid-cols-2 mt-5" onSubmit={handleSubmit}>
							<FormField label="Repository" description="Hugging Face repo id, e.g. owner/model">
								<TextField
									value={form.repoId}
									onChange={(event) =>
										setForm((current) => ({ ...current, repoId: event.target.value }))
									}
									placeholder="owner/model"
									disabled={isBusy || startDownload.isPending}
								/>
							</FormField>
							<FormField label="Filename" description="Remote filename to download">
								<TextField
									value={form.filename}
									onChange={(event) =>
										setForm((current) => ({ ...current, filename: event.target.value }))
									}
									placeholder="model-Q4_K_M.gguf"
									disabled={isBusy || startDownload.isPending}
								/>
							</FormField>
							<FormField label="Display Name" description="Optional label shown in the model list">
								<TextField
									value={form.displayName}
									onChange={(event) =>
										setForm((current) => ({
											...current,
											displayName: event.target.value,
										}))
									}
									placeholder="My Model"
									disabled={isBusy || startDownload.isPending}
								/>
							</FormField>
							<FormField label="Role" description="Target runtime slot for this model">
								<Select
									value={activeRole === "all" ? "text" : activeRole}
									onChange={(event) =>
										setActiveRole(event.target.value as "text" | "embedding")
									}
									disabled={isBusy || startDownload.isPending}
								>
									<option value="text">Text</option>
									<option value="embedding">Embedding</option>
								</Select>
							</FormField>
							<FormField label="Revision" description="Pinned branch, tag, or commit">
								<TextField
									value={form.revision}
									onChange={(event) =>
										setForm((current) => ({ ...current, revision: event.target.value }))
									}
									placeholder="main"
									disabled={isBusy || startDownload.isPending}
								/>
							</FormField>
							<FormField label="SHA256" description="Expected 64-char SHA256 for verification">
								<TextField
									value={form.sha256}
									onChange={(event) =>
										setForm((current) => ({ ...current, sha256: event.target.value }))
									}
									placeholder="Optional but recommended"
									disabled={isBusy || startDownload.isPending}
								/>
							</FormField>
							<div className="flex justify-end md:col-span-2 mt-2">
								<Button type="submit" disabled={isBusy || startDownload.isPending}>
									{startDownload.isPending ? "Starting..." : "Download Model"}
								</Button>
							</div>
						</form>
					</div>
				)}
			</Panel>

			{/* Installed Models Grid */}
			<div className="space-y-4">
				<div className="flex items-center justify-between pb-3 border-b border-border/40 mt-2">
					<h3 className="font-serif text-[18px] font-semibold tracking-wide text-text-main">
						Installed Models
					</h3>
					<p className="text-[11px] font-bold uppercase tracking-widest text-text-muted">
						{filteredModels.length} {filteredModels.length === 1 ? "model" : "models"} found
					</p>
				</div>

				{modelsQuery.isLoading ? (
					<div className="text-sm text-text-muted mt-4">Loading models...</div>
				) : filteredModels.length === 0 ? (
					<div className="flex flex-col items-center justify-center p-12 text-text-muted gap-4 border border-dashed border-border/60 rounded-2xl bg-surface/30 mt-4">
						<div className="w-16 h-16 rounded-2xl bg-primary/5 border border-primary/10 flex items-center justify-center mb-2">
							<Search size={28} className="text-primary/40" />
						</div>
						<p className="text-sm font-medium">No models found matching your criteria.</p>
						{(searchTerm || activeRole !== "all") && (
							<Button
								type="button"
								variant="ghost"
								onClick={() => {
									setSearchTerm("");
									setActiveRole("all");
								}}
								className="mt-2 text-[11px] font-bold uppercase tracking-widest text-primary border border-border/50"
							>
								Clear Filters
							</Button>
						)}
					</div>
				) : (
					<div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 mt-4">
						{filteredModels.map((model) => (
							<SetupModelCard
								key={model.id}
								model={model}
								status={updateStatus[model.id]}
								isBusy={isBusy}
								isChecking={isChecking}
								isDeleting={deleteModel.isPending}
								isUpdating={startDownload.isPending}
								onCheck={() => void checkAllModels([model])}
								onUpdate={() =>
									void startDownloadFlow({
										repo_id: model.repo_id ?? model.source,
										filename: model.filename ?? "",
										role: normalizeModelRole(model.role),
										display_name: model.display_name,
										revision: model.revision ?? undefined,
										sha256: model.sha256 ?? undefined,
										acknowledge_warnings: false,
									})
								}
								onDelete={() => setDeleteTarget(model)}
							/>
						))}
					</div>
				)}
			</div>

			{/* Binary Update Panel */}
			<Panel variant="glass" className="p-6 mt-4">
				<div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
					<div>
						<h3 className="font-serif text-[17px] font-semibold tracking-wide text-text-main">
							llama.cpp Binary
						</h3>
						<p className="mt-1 text-xs text-text-muted tracking-wide">
							Check and install the latest compatible runtime bundle.
						</p>
					</div>
					<Button
						type="button"
						variant="secondary"
						onClick={() =>
							startBinaryUpdate
								.mutateAsync({ variant: "auto" })
								.then((result) => {
									setErrorMessage(null);
									setActiveJob({ jobId: result.job_id, type: "binary" });
								})
								.catch((error) => {
									setErrorMessage(
										error instanceof Error
											? error.message
											: "Failed to start binary update",
									);
								})
						}
						disabled={isBusy || startBinaryUpdate.isPending}
					>
						{startBinaryUpdate.isPending ? "Starting..." : "Update Binary"}
					</Button>
				</div>
				<div className="grid gap-4 md:grid-cols-2">
					<div className="rounded-xl border border-border/50 bg-surface/60 p-5 group hover:bg-surface/80 transition-colors">
						<div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-1.5">
							Current Version
						</div>
						<div className="text-lg font-serif tracking-wide text-text-main group-hover:text-primary transition-colors">
							{binaryInfoQuery.data?.current_version ?? "Unknown"}
						</div>
					</div>
					<div className="rounded-xl border border-border/50 bg-surface/60 p-5 group hover:bg-surface/80 transition-colors">
						<div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-1.5">
							Latest Version
						</div>
						<div className="text-lg font-serif tracking-wide text-text-main group-hover:text-primary transition-colors">
							{binaryInfoQuery.data?.latest_version ?? "Up to date"}
						</div>
					</div>
				</div>
				{binaryInfoQuery.data?.release_notes ? (
					<div className="mt-5 p-4 rounded-xl bg-black/5 dark:bg-white/[0.02] border border-border/30">
						<p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-muted">
							{binaryInfoQuery.data.release_notes}
						</p>
					</div>
				) : null}
			</Panel>

			<ConfirmDialog
				isOpen={Boolean(consentRequest)}
				title="Confirm Download"
				message="This download requires explicit confirmation before it can start."
				variant="warning"
				confirmLabel="Proceed"
				cancelLabel="Cancel"
				onCancel={() => setConsentRequest(null)}
				onConfirm={() => {
					if (!consentRequest) {
						return;
					}
					const payload = {
						...consentRequest.payload,
						acknowledge_warnings: true,
					};
					setConsentRequest(null);
					void startDownloadFlow(payload);
				}}
			>
				<ul className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200 mt-2">
					{(consentRequest?.warnings.length
						? consentRequest.warnings
						: ["This download requires confirmation."]).map((warning) => (
						<li key={warning} className="flex items-start gap-2">
							<span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"></span>
							<span>{warning}</span>
						</li>
					))}
				</ul>
			</ConfirmDialog>

			<ConfirmDialog
				isOpen={Boolean(deleteTarget)}
				title="Delete Model"
				message={
					deleteTarget
						? `Delete ${deleteTarget.display_name}? This removes the model entry and any managed local file.`
						: ""
				}
				variant="danger"
				confirmLabel="Delete"
				cancelLabel="Cancel"
				onCancel={() => setDeleteTarget(null)}
				onConfirm={() => void handleDelete()}
			/>
		</div>
	);
};
