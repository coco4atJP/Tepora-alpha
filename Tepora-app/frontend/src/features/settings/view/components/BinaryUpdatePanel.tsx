import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	isSetupJobRunning,
	isTerminalSetupStatus,
	useBinaryUpdateInfo,
	useSetupJobProgress,
	useStartBinaryUpdate,
} from "../../../../shared/lib/modelManagement";
import { AsyncJobStatus, Button, Panel } from "../../../../shared/ui";

export const BinaryUpdatePanel: React.FC = () => {
	const queryClient = useQueryClient();
	const binaryInfoQuery = useBinaryUpdateInfo();
	const startBinaryUpdate = useStartBinaryUpdate();
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
							message: "Preparing binary update...",
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

		void queryClient.invalidateQueries({
			queryKey: ["v2", "setup", "binary-update-info"],
		});
	}, [activeJobId, progressSnapshot, queryClient]);

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

			<Panel variant="glass" className="p-6">
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
									setActiveJobId(result.job_id);
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
		</div>
	);
};
