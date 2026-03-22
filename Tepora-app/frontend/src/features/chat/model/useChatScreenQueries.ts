import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
	useCreateSessionMutation,
	useV2SessionMessagesQuery,
	useV2SessionsQuery,
} from "../../../shared/lib/sessionQueries";

export function useChatScreenQueries(selectedSessionId: string | null) {
	const queryClient = useQueryClient();
	const sessionsQuery = useV2SessionsQuery();
	const messagesQuery = useV2SessionMessagesQuery(selectedSessionId);
	const createSessionMutation = useCreateSessionMutation();
	const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
	const sessionMessages = useMemo(
		() => messagesQuery.data ?? [],
		[messagesQuery.data],
	);

	return {
		queryClient,
		sessionsQuery,
		messagesQuery,
		createSessionMutation,
		sessions,
		sessionMessages,
	};
}
