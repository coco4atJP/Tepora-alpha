import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type WorkspaceEntry,
	workspaceDocumentSchema,
	workspaceProjectsResponseSchema,
	workspaceTreeResponseSchema,
} from "../contracts";
import { v2ApiClient } from "./api-client";
import { v2DynamicQueryOptions, v2StaticQueryOptions } from "./queryClient";

export const v2WorkspaceQueryKeys = {
	projects: () => ["v2", "workspace", "projects"] as const,
	tree: (projectId: string | null) =>
		["v2", "workspace", projectId ?? "none", "tree"] as const,
	document: (projectId: string | null, path: string | null) =>
		["v2", "workspace", projectId ?? "none", "document", path ?? "none"] as const,
};

export function useWorkspaceProjectsQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: v2WorkspaceQueryKeys.projects(),
			queryFn: async () => {
				const response = await v2ApiClient.get(
					"/api/workspace/projects",
					workspaceProjectsResponseSchema,
				);
				return response;
			},
		}),
	);
}

export function useWorkspaceTreeQuery(projectId: string | null) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: v2WorkspaceQueryKeys.tree(projectId),
			enabled: Boolean(projectId),
			queryFn: async () => {
				if (!projectId) {
					return { tree: [] as WorkspaceEntry[], project_id: "", revision: 0 };
				}
				const response = await v2ApiClient.get(
					`/api/workspace/tree?project_id=${encodeURIComponent(projectId)}`,
					workspaceTreeResponseSchema,
				);
				return response;
			},
		}),
	);
}

export function useWorkspaceDocumentQuery(
	projectId: string | null,
	path: string | null,
) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: v2WorkspaceQueryKeys.document(projectId, path),
			enabled: Boolean(projectId && path),
			queryFn: async () => {
				if (!projectId || !path) {
					return null;
				}
				const response = await v2ApiClient.get(
					`/api/workspace/document/${encodeURIComponent(path)}?project_id=${encodeURIComponent(projectId)}`,
					workspaceDocumentSchema,
				);
				return response;
			},
		}),
	);
}

export function useSelectWorkspaceProjectMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (projectId: string) => {
			await v2ApiClient.post(
				`/api/workspace/projects/${encodeURIComponent(projectId)}/select`,
				workspaceProjectsResponseSchema.partial().passthrough(),
			);
			return projectId;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: v2WorkspaceQueryKeys.projects() });
		},
	});
}

export function useSaveWorkspaceDocumentMutation(
	projectId: string | null,
	path: string | null,
) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (content: string) => {
			if (!projectId || !path) {
				throw new Error("Project ID and path are required");
			}
			await v2ApiClient.patch(
				`/api/workspace/document/${encodeURIComponent(path)}?project_id=${encodeURIComponent(projectId)}`,
				workspaceDocumentSchema,
				{ content },
			);
			return { content };
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: v2WorkspaceQueryKeys.document(projectId, path),
			});
		},
	});
}

export function useCreateWorkspaceDirectoryMutation(projectId: string | null) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (path: string) => {
			if (!projectId) {
				throw new Error("Project ID is required");
			}
			await v2ApiClient.post(
				`/api/workspace/directory/${encodeURIComponent(path)}?project_id=${encodeURIComponent(projectId)}`,
				workspaceDocumentSchema,
			);
			return path;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: v2WorkspaceQueryKeys.projects() });
		},
	});
}

export function useDeleteWorkspacePathMutation(projectId: string | null) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (path: string) => {
			if (!projectId) {
				throw new Error("Project ID is required");
			}
			await v2ApiClient.delete(
				`/api/workspace/path/${encodeURIComponent(path)}?project_id=${encodeURIComponent(projectId)}`,
				workspaceDocumentSchema.partial().passthrough(),
			);
			return path;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: v2WorkspaceQueryKeys.projects() });
		},
	});
}

export function useRenameWorkspacePathMutation(projectId: string | null) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (payload: { oldPath: string; newPath: string }) => {
			if (!projectId) {
				throw new Error("Project ID is required");
			}
			await v2ApiClient.post(
				`/api/workspace/rename/${encodeURIComponent(payload.oldPath)}?project_id=${encodeURIComponent(projectId)}`,
				workspaceDocumentSchema.partial().passthrough(),
				{ new_path: payload.newPath },
			);
			return payload;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: v2WorkspaceQueryKeys.projects() });
		},
	});
}

export function useCreateWorkspaceDocumentMutation(projectId: string | null) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (path: string) => {
			if (!projectId) {
				throw new Error("Project ID is required");
			}
			await v2ApiClient.post(
				`/api/workspace/document/${encodeURIComponent(path)}?project_id=${encodeURIComponent(projectId)}`,
				workspaceDocumentSchema,
				{ content: "" },
			);
			return path;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: v2WorkspaceQueryKeys.projects() });
		},
	});
}