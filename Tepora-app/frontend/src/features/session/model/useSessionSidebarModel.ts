import { startTransition, useEffect, useMemo, useState } from "react";
import { useWorkspaceStore } from "../../../app/model/workspaceStore";
import type { SessionSidebarViewProps } from "../view/props";
import {
	useCreateSessionMutation,
	useDeleteSessionMutation,
	useUpdateSessionMutation,
	useV2SessionsQuery,
} from "./queries";

export function useSessionSidebarModel(): SessionSidebarViewProps {
	const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
	const setSelectedSessionId = useWorkspaceStore(
		(state) => state.setSelectedSessionId,
	);
	const sessionsQuery = useV2SessionsQuery();
	const createSessionMutation = useCreateSessionMutation();
	const updateSessionMutation = useUpdateSessionMutation();
	const deleteSessionMutation = useDeleteSessionMutation();
	const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);

	const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

	useEffect(() => {
		if (sessions.length === 0) {
			if (selectedSessionId) {
				startTransition(() => {
					setSelectedSessionId(null);
				});
			}
			return;
		}

		if (selectedSessionId && sessions.some((session) => session.id === selectedSessionId)) {
			return;
		}

		startTransition(() => {
			setSelectedSessionId(sessions[0].id);
		});
	}, [selectedSessionId, sessions, setSelectedSessionId]);

	return {
		state: sessionsQuery.isLoading ? "loading" : sessionsQuery.error ? "error" : "ready",
		sessions: sessions.map((session) => ({
			id: session.id,
			title: session.title ?? "Untitled session",
			preview: session.preview ?? null,
			updatedAt: session.updated_at,
			messageCount: session.message_count ?? 0,
			isSelected: session.id === selectedSessionId,
		})),
		errorMessage:
			sessionsQuery.error instanceof Error ? sessionsQuery.error.message : null,
		pendingSessionId,
		onSelectSession: setSelectedSessionId,
		onCreateSession: async () => {
			const session = await createSessionMutation.mutateAsync(null);
			startTransition(() => {
				setSelectedSessionId(session.id);
			});
		},
		onRenameSession: async (sessionId, title) => {
			setPendingSessionId(sessionId);
			try {
				await updateSessionMutation.mutateAsync({
					sessionId,
					title,
				});
			} finally {
				setPendingSessionId((current) => (current === sessionId ? null : current));
			}
		},
		onDeleteSession: async (sessionId) => {
			setPendingSessionId(sessionId);
			try {
				await deleteSessionMutation.mutateAsync(sessionId);
				if (selectedSessionId === sessionId) {
					const remainingSessions = sessions.filter((session) => session.id !== sessionId);
					startTransition(() => {
						setSelectedSessionId(remainingSessions[0]?.id ?? null);
					});
				}
			} finally {
				setPendingSessionId((current) => (current === sessionId ? null : current));
			}
		},
	};
}
