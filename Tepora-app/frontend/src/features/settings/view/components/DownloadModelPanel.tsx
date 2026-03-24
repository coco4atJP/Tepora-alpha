import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { consentRequiredErrorResponseSchema } from "../../../../shared/contracts";
import { V2ApiError } from "../../../../shared/lib/api-client";
import {
	formatConsentWarnings,
	isSetupJobRunning,
	isTerminalSetupStatus,
	useSetupJobProgress,
	useStartModelDownload,
} from "../../../../shared/lib/modelManagement";
import { safeParseWithSchema } from "../../../../shared/lib/validation";
import {
	AsyncJobStatus,
	Button,
	ConfirmDialog,
	FormField,
	Panel,
	Select,
	TextField,
} from "../../../../shared/ui";
import { v2SettingsQueryKeys } from "../../model/queries";

const EMPTY_FORM = {
	repoId: "",
	filename: "",
	displayName: "",
	revision: "",
	sha256: "",
};

export const DownloadModelPanel: React.FC = () => {
	const queryClient = useQueryClient();
	const startDownload = useStartModelDownload();
	const [activeRole, setActiveRole] = useState<"text" | "embedding">("text");
	const [isDownloadOpen, setIsDownloadOpen] = useState(false);
	const [form, setForm] = useState(EMPTY_FORM);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [consentRequest, setConsentRequest] = useState<{
		payload: {
			repo_id: string;
			filename: string;
			modality: string;
			assignment_key?: string;
			display_name: string;
			revision?: string;
			sha256?: string;
			acknowledge_warnings?: boolean;
		};
		warnings: string[];
	} | null>(null);
	const handledJobsRef = useRef(new Set<string>());

	const progressQuery = useSetupJobProgress(activeJobId);

	const progressSnapshot = useMemo(
		() =>
			activeJobId && progressQuery.data
				? progressQuery.data
				: activeJobId
					? {
							status: "pending" as const,
							progress: 0,
							message: "Preparing download...",
						}
					: null,
		[activeJobId, progressQuery.data],
	);

	const isBusy = isSetupJobRunning(progressSnapshot?.status);

	useEffect(() => {
		if (!activeJobId || !progressSnapshot || !isTerminalSetupStatus(progressSnapshot.status)) {
			return;
		}
		if (handledJobsRef.current.has(activeJobId)) {
			return;
		}

		handledJobsRef.current.add(activeJobId);
		setErrorMessage(
			progressSnapshot.status === "failed" ? progressSnapshot.message : null,
		);

		if (progressSnapshot.status === "completed") {
			setForm(EMPTY_FORM);
		}

		void queryClient.invalidateQueries({
			queryKey: v2SettingsQueryKeys.models(),
		});
	}, [activeJobId, progressSnapshot, queryClient]);

	const startDownloadFlow = async (payload: {
		repo_id: string;
		filename: string;
		modality: string;
		assignment_key?: string;
		display_name: string;
		revision?: string;
		sha256?: string;
		acknowledge_warnings?: boolean;
	}) => {
		try {
			setErrorMessage(null);
			const result = await startDownload.mutateAsync(payload);
			setActiveJobId(result.job_id);
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
			modality: activeRole,
			assignment_key: activeRole === "embedding" ? "embedding" : "character",
			display_name: form.displayName.trim() || form.filename.trim(),
			revision: form.revision.trim() || undefined,
			sha256: form.sha256.trim() || undefined,
			acknowledge_warnings: false,
		});
	};

	return (
		<div className="flex flex-col gap-4 w-full">
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
									value={activeRole}
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
		</div>
	);
};
