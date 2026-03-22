import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	consentRequiredErrorResponseSchema,
	type SetupModel,
} from "../../../shared/contracts";
import { V2ApiError } from "../../../shared/lib/api-client";
import {
	formatConsentWarnings,
	isSetupJobRunning,
	isTerminalSetupStatus,
	useSetupJobProgress,
} from "../../../shared/lib/modelManagement";
import { safeParseWithSchema } from "../../../shared/lib/validation";
import { v2SettingsQueryKeys } from "./queries";
import type {
	ActiveJobState,
	ConsentRequestState,
	DeleteTarget,
	DownloadPayload,
} from "./modelManagementTypes";

interface StartDownloadResult {
	job_id: string;
}

interface UseModelManagementJobsArgs {
	queryClient: QueryClient;
	startDownload: {
		mutateAsync: (payload: DownloadPayload) => Promise<StartDownloadResult>;
	};
	deleteModel: {
		mutateAsync: (modelId: string) => Promise<unknown>;
	};
}

export function useModelManagementJobs({
	queryClient,
	startDownload,
	deleteModel,
}: UseModelManagementJobsArgs) {
	const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [consentRequest, setConsentRequest] =
		useState<ConsentRequestState | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
	const handledJobsRef = useRef(new Set<string>());

	const progressQuery = useSetupJobProgress(activeJob?.jobId ?? null);

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

	const startDownloadFlow = async (payload: DownloadPayload) => {
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

	const confirmConsentDownload = () => {
		if (!consentRequest) {
			return;
		}

		const payload = {
			...consentRequest.payload,
			acknowledge_warnings: true,
		};
		setConsentRequest(null);
		void startDownloadFlow(payload);
	};

	const handleDelete = async () => {
		const target = deleteTarget;
		if (!target) {
			return;
		}

		try {
			setErrorMessage(null);
			await deleteModel.mutateAsync(target.id);
			setDeleteTarget(null);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Failed to delete model");
		}
	};

	const requestDelete = (target: SetupModel) => {
		setDeleteTarget(target);
	};

	return {
		progressSnapshot,
		isBusy,
		errorMessage,
		consentRequest,
		setConsentRequest,
		deleteTarget,
		setDeleteTarget,
		requestDelete,
		startDownloadFlow,
		confirmConsentDownload,
		handleDelete,
	};
}
