import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
	agentSkillPackageSchema,
	agentSkillsResponseSchema,
	configResponseSchema,
	credentialStatusesResponseSchema,
	mcpConfigResponseSchema,
	mcpInstallConfirmResponseSchema,
	mcpInstallPreviewResponseSchema,
	mcpStatusResponseSchema,
	mcpStoreResponseSchema,
	saveAgentSkillResponseSchema,
	setupModelsResponseSchema,
	successResponseSchema,
	type McpServerConfig,
	type SaveAgentSkillRequest,
	type V2Config,
} from "../../../shared/contracts";
import { v2ApiClient } from "../../../shared/lib/api-client";
import {
	v2DynamicQueryOptions,
	v2StaticQueryOptions,
} from "../../../shared/lib/queryClient";
import { deepMerge } from "./configUtils";

const configWriteResponseSchema = z.object({}).passthrough();

export const v2SettingsQueryKeys = {
	config: () => ["v2", "config"] as const,
	models: () => ["v2", "settings", "models"] as const,
	credentials: () => ["v2", "settings", "credentials"] as const,
	agentSkills: () => ["v2", "settings", "agentSkills"] as const,
	agentSkill: (skillId: string) => ["v2", "settings", "agentSkills", skillId] as const,
	mcpConfig: () => ["v2", "settings", "mcp", "config"] as const,
	mcpStatus: () => ["v2", "settings", "mcp", "status"] as const,
	mcpStore: (params: { search?: string; page?: number; pageSize?: number; runtime?: string }) =>
		["v2", "settings", "mcp", "store", params] as const,
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
		mutationFn: (payload: { model_id: string; assignment_key: "character" | "embedding" }) =>
			v2ApiClient.post("/api/setup/model/active", configWriteResponseSchema, payload),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: v2SettingsQueryKeys.models(),
			});
		},
	});
}

export function useCredentialStatusesQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: v2SettingsQueryKeys.credentials(),
			queryFn: () =>
				v2ApiClient.get("/api/credentials/status", credentialStatusesResponseSchema),
		}),
	);
}

export function useRotateCredentialMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: {
			provider: string;
			secret: string;
			expires_at?: string;
		}) => v2ApiClient.post("/api/credentials/rotate", successResponseSchema, payload),
		onSuccess: () => {
			void Promise.all([
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.credentials(),
				}),
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.config(),
				}),
			]);
		},
	});
}

export function useAgentSkillsQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: v2SettingsQueryKeys.agentSkills(),
			queryFn: () =>
				v2ApiClient.get("/api/agent-skills", agentSkillsResponseSchema),
		}),
	);
}

export function useAgentSkillQuery(skillId: string | null) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: v2SettingsQueryKeys.agentSkill(skillId ?? "__none__"),
			queryFn: () =>
				v2ApiClient.get(
					`/api/agent-skills/${encodeURIComponent(skillId ?? "")}`,
					agentSkillPackageSchema,
				),
			enabled: Boolean(skillId),
		}),
	);
}

export function useSaveAgentSkillMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: SaveAgentSkillRequest) =>
			v2ApiClient.post("/api/agent-skills", saveAgentSkillResponseSchema, payload),
		onSuccess: (response) => {
			void Promise.all([
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.agentSkills(),
				}),
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.agentSkill(response.skill.id),
				}),
			]);
		},
	});
}

export function useDeleteAgentSkillMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (skillId: string) =>
			v2ApiClient.delete(
				`/api/agent-skills/${encodeURIComponent(skillId)}`,
				successResponseSchema,
			),
		onSuccess: (_response, skillId) => {
			void Promise.all([
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.agentSkills(),
				}),
				queryClient.removeQueries({
					queryKey: v2SettingsQueryKeys.agentSkill(skillId),
				}),
			]);
		},
	});
}

export function useMcpConfigQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: v2SettingsQueryKeys.mcpConfig(),
			queryFn: () => v2ApiClient.get("/api/mcp/config", mcpConfigResponseSchema),
		}),
	);
}

export function useMcpStatusQuery() {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: v2SettingsQueryKeys.mcpStatus(),
			queryFn: () => v2ApiClient.get("/api/mcp/status", mcpStatusResponseSchema),
			refetchInterval: 5000,
		}),
	);
}

export function useSaveMcpConfigMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (config: Record<string, McpServerConfig>) =>
			v2ApiClient.post("/api/mcp/config", successResponseSchema, {
				mcpServers: config,
			}),
		onSuccess: () => {
			void Promise.all([
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpConfig(),
				}),
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpStatus(),
				}),
			]);
		},
	});
}

export function useToggleMcpServerMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: { serverName: string; enabled: boolean }) =>
			v2ApiClient.post(
				`/api/mcp/servers/${encodeURIComponent(payload.serverName)}/${payload.enabled ? "enable" : "disable"}`,
				successResponseSchema,
			),
		onSuccess: () => {
			void Promise.all([
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpConfig(),
				}),
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpStatus(),
				}),
			]);
		},
	});
}

export function useDeleteMcpServerMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (serverName: string) =>
			v2ApiClient.delete(
				`/api/mcp/servers/${encodeURIComponent(serverName)}`,
				successResponseSchema,
			),
		onSuccess: () => {
			void Promise.all([
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpConfig(),
				}),
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpStatus(),
				}),
			]);
		},
	});
}

export function useMcpStoreQuery(params: {
	search?: string;
	page?: number;
	pageSize?: number;
	runtime?: string;
	enabled?: boolean;
}) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: v2SettingsQueryKeys.mcpStore(params),
			queryFn: () => {
				const query = new URLSearchParams();
				if (params.search) query.set("search", params.search);
				if (params.page) query.set("page", String(params.page));
				if (params.pageSize) query.set("page_size", String(params.pageSize));
				if (params.runtime) query.set("runtime", params.runtime);
				const suffix = query.toString();
				return v2ApiClient.get(
					suffix ? `/api/mcp/store?${suffix}` : "/api/mcp/store",
					mcpStoreResponseSchema,
				);
			},
			enabled: params.enabled ?? true,
		}),
	);
}

export function useMcpInstallPreviewMutation() {
	return useMutation({
		mutationFn: (payload: {
			server_id: string;
			runtime?: string;
			env_values?: Record<string, string>;
			server_name?: string;
		}) =>
			v2ApiClient.post(
				"/api/mcp/install/preview",
				mcpInstallPreviewResponseSchema,
				payload,
			),
	});
}

export function useMcpInstallConfirmMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (consentId: string) =>
			v2ApiClient.post(
				"/api/mcp/install/confirm",
				mcpInstallConfirmResponseSchema,
				{ consent_id: consentId },
			),
		onSuccess: () => {
			void Promise.all([
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpConfig(),
				}),
				queryClient.invalidateQueries({
					queryKey: v2SettingsQueryKeys.mcpStatus(),
				}),
				queryClient.invalidateQueries({
					queryKey: ["v2", "settings", "mcp", "store"],
				}),
			]);
		},
	});
}
