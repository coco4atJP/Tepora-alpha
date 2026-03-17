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
