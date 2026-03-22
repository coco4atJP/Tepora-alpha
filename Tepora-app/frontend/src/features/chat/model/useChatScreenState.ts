import { useChatInteractionState } from "./useChatInteractionState";
import { useChatRuntimeBindings } from "./useChatRuntimeBindings";
import { useChatScreenQueries } from "./useChatScreenQueries";

export function useChatScreenState() {
	const runtime = useChatRuntimeBindings();
	const queries = useChatScreenQueries(runtime.selectedSessionId);
	const interaction = useChatInteractionState(queries.createSessionMutation.isPending);

	return {
		...runtime,
		...queries,
		...interaction,
	};
}
