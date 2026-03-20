import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createSessionResponseSchema,
	type Session,
	sessionMessagesResponseSchema,
	sessionsResponseSchema,
} from "../../../shared/contracts";
import { v2ApiClient } from "../../../shared/lib/api-client";
import {
	v2DynamicQueryOptions,
	v2StaticQueryOptions,
} from "../../../shared/lib/queryClient";

export const v2SessionQueryKeys = {
	sessions: () => ["v2", "sessions"] as const,
	sessionMessages: (sessionId: string | null) =>
		["v2", "sessions", sessionId ?? "none", "messages"] as const,
};

export function useV2SessionsQuery() {
	return useQuery(
		v2StaticQueryOptions({
			queryKey: v2SessionQueryKeys.sessions(),
			queryFn: async () => {
				const response = await v2ApiClient.get(
					"/api/sessions",
					sessionsResponseSchema,
				);
				return response.sessions;
			},
		}),
	);
}

export function useV2SessionMessagesQuery(sessionId: string | null) {
	return useQuery(
		v2DynamicQueryOptions({
			queryKey: v2SessionQueryKeys.sessionMessages(sessionId),
			enabled: Boolean(sessionId),
			queryFn: async () => {
				if (!sessionId) {
					return [];
				}

				const response = await v2ApiClient.get(
					`/api/sessions/${sessionId}/messages?limit=100`,
					sessionMessagesResponseSchema,
				);
				return response.messages;
			},
		}),
	);
}

export function useCreateSessionMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (title?: string | null) => {
			const payload = title === undefined ? undefined : { title };
			const response = await v2ApiClient.post(
				"/api/sessions",
				createSessionResponseSchema,
				payload,
			);
			return response.session;
		},
		onSuccess: (session) => {
			queryClient.setQueryData<Session[]>(
				v2SessionQueryKeys.sessions(),
				(current = []) => [
					session,
					...current.filter((item) => item.id !== session.id),
				],
			);
		},
	});
}

export function useUpdateSessionMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (payload: { sessionId: string; title: string }) => {
			await v2ApiClient.patch(
				`/api/sessions/${encodeURIComponent(payload.sessionId)}`,
				createSessionResponseSchema.partial().passthrough(),
				{ title: payload.title },
			);
			return payload;
		},
		onSuccess: ({ sessionId, title }) => {
			queryClient.setQueryData<Session[]>(
				v2SessionQueryKeys.sessions(),
				(current = []) =>
					current.map((session) =>
						session.id === sessionId ? { ...session, title } : session,
					),
			);
			void queryClient.invalidateQueries({
				queryKey: v2SessionQueryKeys.sessions(),
			});
		},
	});
}

export function useDeleteSessionMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (sessionId: string) => {
			await v2ApiClient.delete(
				`/api/sessions/${encodeURIComponent(sessionId)}`,
				createSessionResponseSchema.partial().passthrough(),
			);
			return sessionId;
		},
		onSuccess: (sessionId) => {
			queryClient.setQueryData<Session[]>(
				v2SessionQueryKeys.sessions(),
				(current = []) => current.filter((session) => session.id !== sessionId),
			);
			queryClient.removeQueries({
				queryKey: v2SessionQueryKeys.sessionMessages(sessionId),
			});
			void queryClient.invalidateQueries({
				queryKey: v2SessionQueryKeys.sessions(),
			});
		},
	});
}
