import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
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
	useModelUpdateCheck,
	useSetupJobProgress,
	useStartModelDownload,
} from "../../../shared/lib/modelManagement";
import { safeParseWithSchema } from "../../../shared/lib/validation";
import {
	AsyncJobStatus,
	Button,
	ConfirmDialog,
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



export const ModelManagementSection: React.FC = () => {
	const queryClient = useQueryClient();
	const modelsQuery = useV2SetupModelsQuery();
	const deleteModel = useDeleteSetupModelMutation();
	const startDownload = useStartModelDownload();
	const { updateStatus, isChecking, checkAllModels } = useModelUpdateCheck();
	const [activeRole, setActiveRole] = useState<"all" | "text" | "embedding">("all");
	const [searchTerm, setSearchTerm] = useState("");
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
							message: "Preparing download...",
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

		void queryClient.invalidateQueries({
			queryKey: v2SettingsQueryKeys.models(),
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
