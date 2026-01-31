import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { Session } from "../types";
import { apiClient } from "../utils/api-client";
import { ENDPOINTS } from "../utils/endpoints";

// Re-export Session type for backward compatibility
export type { Session } from "../types";

interface UseSessionsReturn {
	sessions: Session[];
	loading: boolean;
	error: string | null;
	fetchSessions: () => Promise<void>;
	createSession: (title?: string) => Promise<Session | null>;
	deleteSession: (id: string) => Promise<boolean>;
	renameSession: (id: string, title: string) => Promise<boolean>;
}

export const useSessions = (): UseSessionsReturn => {
	const queryClient = useQueryClient();

	const {
		data: sessions = [],
		isLoading: loading,
		error: queryError,
		refetch,
	} = useQuery({
		queryKey: ["sessions"],
		queryFn: async () => {
			const data = await apiClient.get<{ sessions: Session[] }>(ENDPOINTS.SESSIONS.LIST);
			return data.sessions || [];
		},
		staleTime: 1000 * 60, // 1 minute
	});

	const createMutation = useMutation({
		mutationFn: (title?: string) =>
			apiClient.post<{ session: Session }>(ENDPOINTS.SESSIONS.LIST, { title }),
		onSuccess: (data) => {
			queryClient.setQueryData(["sessions"], (old: Session[] = []) => [data.session, ...old]);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => apiClient.delete(ENDPOINTS.SESSIONS.DETAIL(id)),
		onSuccess: (_, id) => {
			queryClient.setQueryData(["sessions"], (old: Session[] = []) =>
				old.filter((s) => s.id !== id),
			);
		},
	});

	const renameMutation = useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) =>
			apiClient.patch(ENDPOINTS.SESSIONS.DETAIL(id), { title }),
		onSuccess: (_, { id, title }) => {
			queryClient.setQueryData(["sessions"], (old: Session[] = []) =>
				old.map((s) => (s.id === id ? { ...s, title } : s)),
			);
		},
	});

	// UX改善2: メッセージ送信完了時にセッションリストを自動リフレッシュ
	useEffect(() => {
		const handleSessionRefresh = () => {
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
		};
		window.addEventListener("session-refresh", handleSessionRefresh);
		return () => {
			window.removeEventListener("session-refresh", handleSessionRefresh);
		};
	}, [queryClient]);

	const fetchSessions = useCallback(async () => {
		await refetch();
	}, [refetch]);

	const createSession = useCallback(
		async (title?: string) => {
			try {
				const data = await createMutation.mutateAsync(title);
				return data.session;
			} catch (e) {
				console.error(e);
				return null;
			}
		},
		[createMutation],
	);

	const deleteSession = useCallback(
		async (id: string) => {
			try {
				await deleteMutation.mutateAsync(id);
				return true;
			} catch (e) {
				console.error(e);
				return false;
			}
		},
		[deleteMutation],
	);

	const renameSession = useCallback(
		async (id: string, title: string) => {
			try {
				await renameMutation.mutateAsync({ id, title });
				return true;
			} catch (e) {
				console.error(e);
				return false;
			}
		},
		[renameMutation],
	);

	return {
		sessions,
		loading,
		error: queryError ? (queryError as Error).message : null,
		fetchSessions,
		createSession,
		deleteSession,
		renameSession,
	};
};
