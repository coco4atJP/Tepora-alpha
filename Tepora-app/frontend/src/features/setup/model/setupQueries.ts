import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
	requirementsResponseSchema,
	setupModelsResponseSchema,
	startModelDownloadRequestSchema,
	setupProgressResponseSchema,
	successResponseSchema,
} from "../../../shared/contracts";
import { v2ApiClient } from "../../../shared/lib/api-client";
import { v2DynamicQueryOptions, v2StaticQueryOptions } from "../../../shared/lib/queryClient";

export const setupQueryKeys = {
	requirements: () => ["v2", "setup", "requirements"] as const,
	defaultModels: () => ["v2", "setup", "defaultModels"] as const,
	progress: () => ["v2", "setup", "progress"] as const,
};

// --- Queries ---

export function useRequirementsQuery() {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: setupQueryKeys.requirements(),
			queryFn: () => v2ApiClient.get("/api/setup/requirements", requirementsResponseSchema),
		}),
	);
}

export function useSetupDefaultModelsQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: setupQueryKeys.defaultModels(),
			queryFn: () => v2ApiClient.get("/api/setup/default-models", setupModelsResponseSchema),
		}),
	);
}

export function useSetupProgressQuery(enabled: boolean) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: setupQueryKeys.progress(),
			queryFn: () => v2ApiClient.get("/api/setup/progress", setupProgressResponseSchema),
			enabled,
			refetchInterval: (query) => {
				const status = query.state.data?.status;
				if (status === "done" || status === "error") {
					return false;
				}
				return 1000;
			},
		}),
	);
}

// --- Mutations ---

export function useSetupInitMutation() {
	return useMutation({
		mutationFn: (payload: { language: string }) =>
			v2ApiClient.post("/api/setup/init", successResponseSchema, payload),
	});
}

// System Check background refresh actions
export function useRefreshOllamaMutation() {
	const countSchema = z.number();
	return useMutation({
		mutationFn: () => v2ApiClient.post("/api/setup/models/ollama/refresh", countSchema),
	});
}

export function useRefreshLmStudioMutation() {
	const countSchema = z.number();
	return useMutation({
		mutationFn: () => v2ApiClient.post("/api/setup/models/lmstudio/refresh", countSchema),
	});
}

export function useSetupPreflightMutation() {
	const emptyResponseSchema = z.object({}).passthrough();
	return useMutation({
		mutationFn: (models: z.infer<typeof startModelDownloadRequestSchema>[]) =>
			v2ApiClient.post("/api/setup/preflight", emptyResponseSchema, models),
	});
}

export function useSetupRunMutation() {
	const emptyResponseSchema = z.object({}).passthrough();
	return useMutation({
		mutationFn: (models: z.infer<typeof startModelDownloadRequestSchema>[]) =>
			v2ApiClient.post("/api/setup/run", emptyResponseSchema, models),
	});
}

export function useSetupFinishMutation() {
	return useMutation({
		mutationFn: (payload: { config_overrides: Record<string, unknown> }) =>
			v2ApiClient.post("/api/setup/finish", successResponseSchema, payload),
	});
}
