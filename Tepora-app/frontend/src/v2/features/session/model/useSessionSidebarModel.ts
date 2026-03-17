import { startTransition, useEffect } from "react";
import { useWorkspaceStore } from "../../../app/model/workspaceStore";
import type { SessionSidebarViewProps } from "../view/props";
import { useCreateSessionMutation, useV2SessionsQuery } from "./queries";

export function useSessionSidebarModel(): SessionSidebarViewProps {
	const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
	const setSelectedSessionId = useWorkspaceStore(
		(state) => state.setSelectedSessionId,
	);
	const sessionsQuery = useV2SessionsQuery();
	const createSessionMutation = useCreateSessionMutation();

	const sessions = sessionsQuery.data ?? [];

	useEffect(() => {
		if (selectedSessionId || sessions.length === 0) {
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
		onSelectSession: setSelectedSessionId,
		onCreateSession: async () => {
			const session = await createSessionMutation.mutateAsync(null);
			startTransition(() => {
				setSelectedSessionId(session.id);
			});
		},
	};
}
