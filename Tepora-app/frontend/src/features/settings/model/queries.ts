import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
	configResponseSchema,
	setupModelsResponseSchema,
	type V2Config,
} from "../../../shared/contracts";
import { v2ApiClient } from "../../../shared/lib/api-client";
import { v2StaticQueryOptions } from "../../../shared/lib/queryClient";
import { deepMerge } from "./configUtils";

const configWriteResponseSchema = z.object({}).passthrough();

export const v2SettingsQueryKeys = {
	config: () => ["v2", "config"] as const,
	models: () => ["v2", "settings", "models"] as const,
};

export function useV2ConfigQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: v2SettingsQueryKeys.config(),
			queryFn: () => v2ApiClient.get("/api/config", configResponseSchema),
		}),
	);
}

export function useSaveV2ConfigMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (patch: Record<string, unknown>) =>
			v2ApiClient.patch("/api/config", configWriteResponseSchema, patch),
		onSuccess: (_response, patch) => {
			queryClient.setQueryData<V2Config | undefined>(
				v2SettingsQueryKeys.config(),
				(current) => {
					if (!current) {
						return current;
					}

					return deepMerge(current, patch) as V2Config;
				},
			);
		},
		onSettled: () => {
			void queryClient.invalidateQueries({
				queryKey: v2SettingsQueryKeys.config(),
			});
		},
	});
}

export function useV2SetupModelsQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: v2SettingsQueryKeys.models(),
			queryFn: () =>
				v2ApiClient.get("/api/setup/models", setupModelsResponseSchema),
		}),
	);
}

export function useDeleteSetupModelMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (modelId: string) =>
			v2ApiClient.delete(`/api/setup/model/${encodeURIComponent(modelId)}`, configWriteResponseSchema),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: v2SettingsQueryKeys.models(),
			});
		},
	});
}

export function useSetActiveSetupModelMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: { model_id: string; role: "text" | "embedding" }) =>
			v2ApiClient.post("/api/setup/model/active", configWriteResponseSchema, payload),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: v2SettingsQueryKeys.models(),
			});
		},
	});
}
