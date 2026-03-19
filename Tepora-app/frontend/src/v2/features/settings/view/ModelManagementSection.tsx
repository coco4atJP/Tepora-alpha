import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
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
	const [activeRole, setActiveRole] = useState<"text" | "embedding">("text");
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
	const filteredModels = normalizedModels.filter((model) => model.role === activeRole);
	const remoteModels = filteredModels.filter((model) => Boolean(model.repo_id));
	const progressSnapshot =
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
				: null;
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
			role: activeRole,
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
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center gap-3">
				{(["text", "embedding"] as const).map((role) => (
					<Button
						key={role}
						type="button"
						variant={activeRole === role ? "primary" : "ghost"}
						onClick={() => setActiveRole(role)}
					>
						{role === "text" ? "Text Models" : "Embedding Models"}
					</Button>
				))}
				<Button
					type="button"
					variant="secondary"
					onClick={() => void checkAllModels(remoteModels)}
					disabled={isChecking || remoteModels.length === 0 || isBusy}
				>
					{isChecking ? "Checking..." : "Check Updates"}
				</Button>
			</div>

			{progressSnapshot ? (
				<AsyncJobStatus
					status={progressSnapshot.status}
					progress={progressSnapshot.progress}
					message={progressSnapshot.message}
				/>
			) : null}

			{errorMessage ? (
				<div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
					{errorMessage}
				</div>
			) : null}

			<Panel variant="glass" className="p-5">
				<div className="mb-4 flex items-center justify-between gap-4">
					<div>
						<h3 className="font-serif text-xl text-text-main">Download Model</h3>
						<p className="mt-1 text-sm text-text-muted">
							Add a remote model with explicit revision and SHA when available.
						</p>
					</div>
				</div>
				<form className="grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
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
							value={activeRole}
							onChange={(event) =>
								setActiveRole(event.target.value === "embedding" ? "embedding" : "text")
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
					<div className="flex justify-end md:col-span-2">
						<Button type="submit" disabled={isBusy || startDownload.isPending}>
							{startDownload.isPending ? "Starting..." : "Download Model"}
						</Button>
					</div>
				</form>
			</Panel>

			<Panel variant="glass" className="p-5">
				<div className="mb-4 flex items-center justify-between gap-4">
					<div>
						<h3 className="font-serif text-xl text-text-main">Installed Models</h3>
						<p className="mt-1 text-sm text-text-muted">
							Text and embedding models are normalized here even if legacy data still uses
							character roles.
						</p>
					</div>
				</div>
				<div className="space-y-3">
					{modelsQuery.isLoading ? (
						<div className="text-sm text-text-muted">Loading models...</div>
					) : filteredModels.length === 0 ? (
						<div className="text-sm text-text-muted">
							No models registered for this role yet.
						</div>
					) : (
						filteredModels.map((model) => {
							const status = updateStatus[model.id];
							return (
								<div
									key={model.id}
									className="rounded-2xl border border-white/10 bg-surface/80 p-4"
								>
									<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<div className="font-medium text-text-main">{model.display_name}</div>
												{model.is_active ? (
													<span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">
														Active
													</span>
												) : null}
												{status?.update_available ? (
													<span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200">
														Update available
													</span>
												) : status?.reason === "up_to_date" ? (
													<span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">
														Up to date
													</span>
												) : null}
											</div>
											<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
												<span>{model.filename ?? model.source}</span>
												<span>{(model.file_size / (1024 * 1024)).toFixed(1)} MB</span>
												<span>{model.loader ?? "llama_cpp"}</span>
												{model.revision ? <span>rev: {model.revision}</span> : null}
											</div>
										</div>
										<div className="flex flex-wrap gap-2">
											<Button
												type="button"
												variant="ghost"
												onClick={() => void checkAllModels([model])}
												disabled={isBusy || isChecking || !model.repo_id}
											>
												Check
											</Button>
											<Button
												type="button"
												variant="secondary"
												onClick={() =>
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
												disabled={
													isBusy ||
													startDownload.isPending ||
													!model.repo_id ||
													!status?.update_available
												}
											>
												Update
											</Button>
											<Button
												type="button"
												variant="ghost"
												onClick={() => setDeleteTarget(model)}
												disabled={isBusy || deleteModel.isPending}
												className="border border-red-500/20 text-red-300 hover:bg-red-500/10"
											>
												Delete
											</Button>
										</div>
									</div>
								</div>
							);
						})
					)}
				</div>
			</Panel>

			<Panel variant="glass" className="p-5">
				<div className="mb-4 flex items-center justify-between gap-4">
					<div>
						<h3 className="font-serif text-xl text-text-main">llama.cpp Binary</h3>
						<p className="mt-1 text-sm text-text-muted">
							Check and install the latest compatible runtime bundle.
						</p>
					</div>
					<Button
						type="button"
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
				<div className="grid gap-3 md:grid-cols-2">
					<div className="rounded-2xl border border-white/10 bg-surface/80 p-4">
						<div className="text-xs uppercase tracking-[0.14em] text-text-muted">
							Current Version
						</div>
						<div className="mt-2 text-lg text-text-main">
							{binaryInfoQuery.data?.current_version ?? "Unknown"}
						</div>
					</div>
					<div className="rounded-2xl border border-white/10 bg-surface/80 p-4">
						<div className="text-xs uppercase tracking-[0.14em] text-text-muted">
							Latest Version
						</div>
						<div className="mt-2 text-lg text-text-main">
							{binaryInfoQuery.data?.latest_version ?? "Up to date"}
						</div>
					</div>
				</div>
				{binaryInfoQuery.data?.release_notes ? (
					<p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-text-muted">
						{binaryInfoQuery.data.release_notes}
					</p>
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
				<ul className="space-y-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
					{(consentRequest?.warnings.length
						? consentRequest.warnings
						: ["This download requires confirmation."]).map((warning) => (
						<li key={warning}>{warning}</li>
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
