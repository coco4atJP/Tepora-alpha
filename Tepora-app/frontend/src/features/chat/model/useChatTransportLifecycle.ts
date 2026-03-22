import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ChatFlowEvent } from "./chatMachine";
import type { ChatPipelineAction } from "./messagePipeline";
import { v2TransportAdapter, type V2TransportConnectionSnapshot } from "../../../shared/lib/transportAdapter";
import { v2SessionQueryKeys } from "../../../shared/lib/sessionQueries";

interface UseChatTransportLifecycleParams {
	queryClient: QueryClient;
	sendToMachine: (event: ChatFlowEvent) => void;
	dispatchPipeline: React.Dispatch<ChatPipelineAction>;
	setConnection: (snapshot: V2TransportConnectionSnapshot) => void;
}

export function useChatTransportLifecycle({
	queryClient,
	sendToMachine,
	dispatchPipeline,
	setConnection,
}: UseChatTransportLifecycleParams) {
	useEffect(() => {
		void v2TransportAdapter.connect();
		const unsubscribeConnection = v2TransportAdapter.subscribeConnection(
			(snapshot) => {
				setConnection(snapshot);
				if (snapshot.status === "reconnecting") {
					sendToMachine({ type: "RECONNECT_INVALIDATED" });
				}
			},
		);
		const unsubscribeMessages = v2TransportAdapter.subscribe((message) => {
			switch (message.type) {
				case "chunk":
				case "thought":
					sendToMachine({
						type: "STREAM_EVENT",
						streamId: message.streamId,
					});
					break;
				case "tool_confirmation_request":
					sendToMachine({
						type: "TOOL_CONFIRMATION_REQUIRED",
						requestId: message.data.requestId,
					});
					break;
				case "done":
					sendToMachine({ type: "DONE" });
					break;
				case "stopped":
					sendToMachine({ type: "STOPPED" });
					break;
				case "error":
					sendToMachine({ type: "FAILED", message: message.message });
					break;
				case "interaction_complete":
					void queryClient.invalidateQueries({
						queryKey: v2SessionQueryKeys.sessionMessages(message.sessionId),
					});
					void queryClient.invalidateQueries({
						queryKey: v2SessionQueryKeys.sessions(),
					});
					break;
				case "session_changed":
					void queryClient.invalidateQueries({
						queryKey: v2SessionQueryKeys.sessionMessages(message.sessionId),
					});
					break;
			}

			dispatchPipeline({
				type: "TRANSPORT_MESSAGE",
				message,
			});
		});

		return () => {
			unsubscribeConnection();
			unsubscribeMessages();
			v2TransportAdapter.disconnect();
		};
	}, [dispatchPipeline, queryClient, sendToMachine, setConnection]);
}
