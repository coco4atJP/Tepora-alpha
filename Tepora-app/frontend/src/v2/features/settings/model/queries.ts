import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
	configResponseSchema,
	type V2Config,
} from "../../../shared/contracts";
import { v2ApiClient } from "../../../shared/lib/api-client";
import { v2StaticQueryOptions } from "../../../shared/lib/queryClient";

const configWriteResponseSchema = z.object({}).passthrough();

export const v2SettingsQueryKeys = {
	config: () => ["v2", "config"] as const,
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

function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const nextTarget: Record<string, unknown> = { ...target };

	for (const [key, value] of Object.entries(source)) {
		const currentValue = nextTarget[key];
		if (isRecord(currentValue) && isRecord(value)) {
			nextTarget[key] = deepMerge(currentValue, value);
			continue;
		}

		nextTarget[key] = value;
	}

	return nextTarget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
