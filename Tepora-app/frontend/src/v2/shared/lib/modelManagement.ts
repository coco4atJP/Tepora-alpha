import {
	useMutation,
	useQuery,
	type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
	binaryUpdateInfoResponseSchema,
	type ModelUpdateCheckResponse,
	modelUpdateCheckResponseSchema,
	type SetupModel,
	type SetupProgressResponse,
	setupProgressResponseSchema,
	type StartBinaryUpdateRequest,
	startBinaryUpdateResponseSchema,
	type StartModelDownloadRequest,
	startModelDownloadResponseSchema,
} from "../contracts";
import { v2ApiClient } from "./api-client";
import { v2DynamicQueryOptions, v2StaticQueryOptions } from "./queryClient";

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
		async (models: readonly Pick<SetupModel, "id" | "repo_id">[]) => {
			setIsChecking(true);
			try {
				await Promise.all(
					models
						.filter((model) => Boolean(model.repo_id))
						.map((model) => checkUpdate(model.id)),
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
		checkUpdate,
		checkAllModels,
	};
}

export function useSetupJobProgress(jobId: string | null) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: ["v2", "setup", "progress", jobId],
			enabled: Boolean(jobId),
			queryFn: () =>
				v2ApiClient.get("/api/setup/progress", setupProgressResponseSchema),
			refetchInterval: (query) => {
				const data = query.state.data as SetupProgressResponse | undefined;
				if (!data) {
					return 500;
				}
				return data.status === "completed" || data.status === "failed"
					? false
					: 500;
			},
		}),
	);
}

export function useStartModelDownload(): UseMutationResult<
	{ success: true; job_id: string },
	Error,
	StartModelDownloadRequest
> {
	return useMutation({
		mutationFn: async (payload: StartModelDownloadRequest) => {
			const result = await v2ApiClient.post(
				"/api/setup/model/download",
				startModelDownloadResponseSchema,
				payload,
			);
			if (!result.success || !result.job_id) {
				throw new Error("Failed to start model download");
			}
			return {
				success: true as const,
				job_id: result.job_id,
			};
		},
	});
}

export function useBinaryUpdateInfo() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: ["v2", "setup", "binary-update-info"],
			queryFn: () =>
				v2ApiClient.get(
					"/api/setup/binary/update-info",
					binaryUpdateInfoResponseSchema,
				),
		}),
	);
}

export function useStartBinaryUpdate(): UseMutationResult<
	{ success: true; job_id: string },
	Error,
	StartBinaryUpdateRequest | undefined
> {
	return useMutation({
		mutationFn: async (payload?: StartBinaryUpdateRequest) => {
			const result = await v2ApiClient.post(
				"/api/setup/binary/update",
				startBinaryUpdateResponseSchema,
				payload ?? { variant: "auto" },
			);
			if (!result.success || !result.job_id) {
				throw new Error("Failed to start binary update");
			}
			return {
				success: true as const,
				job_id: result.job_id,
			};
		},
	});
}

export function normalizeModelRole(role: string): "text" | "embedding" {
	return role === "embedding" ? "embedding" : "text";
}

export function isTerminalSetupStatus(status: string | undefined): boolean {
	return status === "completed" || status === "failed";
}

export function isSetupJobRunning(status: string | undefined): boolean {
	return Boolean(status) && !isTerminalSetupStatus(status) && status !== "idle";
}

export function formatConsentWarnings(warnings: readonly unknown[]): string[] {
	return warnings.flatMap((warning) => {
		if (typeof warning === "string") {
			return [warning];
		}
		if (
			warning &&
			typeof warning === "object" &&
			Array.isArray((warning as { warnings?: unknown }).warnings)
		) {
			return (warning as { warnings: unknown[] }).warnings.filter(
				(item): item is string => typeof item === "string",
			);
		}
		return [];
	});
}
