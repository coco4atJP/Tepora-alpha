import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
	binaryUpdateInfoResponseSchema,
	modelUpdateCheckResponseSchema,
	setupProgressResponseSchema,
	startBinaryUpdateResponseSchema,
	startModelDownloadResponseSchema,
	type ModelUpdateCheckResponse,
} from "../contracts";
import { v2ApiClient } from "./api-client";
import { v2DynamicQueryOptions, v2StaticQueryOptions } from "./queryClient";

export function normalizeModelRole(
	role: string | null | undefined,
): "text" | "embedding" {
	return role === "embedding" ? "embedding" : "text";
}

export function formatConsentWarnings(
	warnings: Array<string | { warnings?: string[] }>,
) {
	return warnings.flatMap((warning) => {
		if (typeof warning === "string") {
			return [warning];
		}

		return warning.warnings?.filter((item): item is string => Boolean(item)) ?? [];
	});
}

export function isTerminalSetupStatus(status: string | null | undefined) {
	return status === "completed" || status === "failed" || status === "cancelled";
}

export function isSetupJobRunning(status: string | null | undefined) {
	return Boolean(status) && !isTerminalSetupStatus(status);
}

export function useSetupJobProgress(jobId: string | null) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: ["v2", "setup", "progress", jobId ?? "none"] as const,
			enabled: Boolean(jobId),
			queryFn: () =>
				v2ApiClient.get(
					jobId
						? `/api/setup/progress?job_id=${encodeURIComponent(jobId)}`
						: "/api/setup/progress",
					setupProgressResponseSchema,
				),
			refetchInterval: (query) =>
				isSetupJobRunning(query.state.data?.status) ? 1_000 : false,
		}),
	);
}

export function useStartModelDownload() {
	return useMutation({
		mutationFn: async (payload: {
			repo_id: string;
			filename: string;
			role: string;
			display_name: string;
			revision?: string;
			sha256?: string;
			acknowledge_warnings?: boolean;
		}) => {
			const response = await v2ApiClient.post(
				"/api/setup/model/download",
				startModelDownloadResponseSchema,
				payload,
			);
			if (!response.job_id) {
				throw new Error("Download job id was not returned by the API.");
			}
			return { job_id: response.job_id };
		},
	});
}

export function useModelUpdateCheck() {
	const [updateStatus, setUpdateStatus] = useState<
		Record<string, ModelUpdateCheckResponse>
	>({});
	const [isChecking, setIsChecking] = useState(false);

	const checkUpdate = useCallback(async (modelId: string) => {
		const result = await v2ApiClient.get(
			`/api/setup/model/update-check?model_id=${encodeURIComponent(modelId)}`,
			modelUpdateCheckResponseSchema,
		);
		setUpdateStatus((current) => ({
			...current,
			[modelId]: result,
		}));
		return result;
	}, []);

	const checkAllModels = useCallback(
		async (models: Array<string | { id: string }>) => {
			setIsChecking(true);
			try {
				await Promise.all(
					models.map((model) =>
						checkUpdate(typeof model === "string" ? model : model.id),
					),
				);
			} finally {
				setIsChecking(false);
			}
		},
		[checkUpdate],
	);

	return {
		updateStatus,
		isChecking,
		checkAllModels,
	};
}

export function useBinaryUpdateInfo() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: ["v2", "setup", "binary-update-info"] as const,
			queryFn: () =>
				v2ApiClient.get(
					"/api/setup/binary/update-info",
					binaryUpdateInfoResponseSchema,
				),
		}),
	);
}

export function useStartBinaryUpdate() {
	return useMutation({
		mutationFn: async (payload: { variant?: string }) => {
			const response = await v2ApiClient.post(
				"/api/setup/binary/update",
				startBinaryUpdateResponseSchema,
				payload,
			);
			if (!response.job_id) {
				throw new Error("Binary update job id was not returned by the API.");
			}
			return { job_id: response.job_id };
		},
	});
}
