import { chatActor } from "../machines/chatMachine";
import type { ToolConfirmationRequest } from "../types";
import { logger } from "../utils/logger";
import { useChatStore } from "./chatStore";
import { useSessionStore } from "./sessionStore";
import { useToolConfirmationStore } from "./toolConfirmationStore";

const AGENT_MAPPING: Record<string, string> = {
	generate_order: "Planner",
	generate_search_query: "Search Analyst",
	execute_search: "Search Tool",
	summarize_search_result: "Researcher",
	agent_reasoning: "Professional Agent",
	tool_node: "Tool Handler",
	synthesize_final_response: "Synthesizer",
	update_scratchpad: "Memory Manager",
	thinking: "Deep Thinker",
	supervisor: "Supervisor",
};

interface RouterDeps {
	autoApproveToolConfirmation: (request: ToolConfirmationRequest) => void;
}

export function routeIncomingMessage(rawData: string, deps: RouterDeps) {
	try {
		const data = JSON.parse(rawData);
		const chatStore = useChatStore.getState();
		const sessionStore = useSessionStore.getState();

		switch (data.type) {
			case "chunk":
				chatActor.send({
					type: "RECV_CHUNK",
					payload: data.message || data.text || "",
					metadata: {
						mode: data.mode,
						agentName: data.agentName,
						nodeId: data.nodeId,
					},
				});
				break;

			case "done":
				chatActor.send({ type: "DONE" });
				break;

			case "interaction_complete":
				window.dispatchEvent(new CustomEvent("session-refresh"));
				break;

			case "memory_generation":
				chatStore.setIsGeneratingMemory(data.status === "started");
				break;

			case "thought":
				if (data.content) {
					chatStore.updateMessageThinking(data.content);
				}
				break;

			case "stopped":
				chatActor.send({ type: "DONE" });
				break;

			case "error":
				chatStore.setError(data.message || "Unknown error");
				chatStore.addMessage({
					id: Date.now().toString(),
					role: "system",
					content: `Error: ${data.message || "Unknown error"}`,
					timestamp: new Date(),
				});
				chatActor.send({ type: "ERROR", error: new Error(data.message || "Unknown error") });
				break;

			case "stats":
				if (data.data) {
					chatStore.setMemoryStats(data.data);
				}
				break;

			case "search_results":
				if (data.data && Array.isArray(data.data)) {
					chatStore.setSearchResults(data.data);
				}
				break;

			case "activity":
				if (data.data) {
					const rawEntry = data.data;
					const agentName = rawEntry.agentName || AGENT_MAPPING[rawEntry.id] || rawEntry.id;
					const statusMap: Record<string, "pending" | "processing" | "completed" | "error"> = {
						done: "completed",
						processing: "processing",
						pending: "pending",
						error: "error",
					};
					chatStore.updateActivity({
						status: statusMap[rawEntry.status] || "processing",
						agent_name: agentName,
						details: rawEntry.message,
						step: 0,
					});
				}
				break;

			case "tool_confirmation_request":
				if (data.data) {
					const request = data.data as ToolConfirmationRequest;
					if (useToolConfirmationStore.getState().approvedTools.has(request.toolName)) {
						deps.autoApproveToolConfirmation(request);
					} else {
						useToolConfirmationStore.getState().setPendingToolConfirmation(request);
					}
				}
				break;

			case "history":
				if (data.messages && Array.isArray(data.messages)) {
					const parsedMessages = data.messages.map(
						(msg: { timestamp: string | number | Date }) => ({
							...msg,
							timestamp: new Date(msg.timestamp),
						}),
					);
					chatStore.setMessages(parsedMessages);
				}
				sessionStore.setIsLoadingHistory(false);
				break;

			case "session_changed":
				if (import.meta.env.DEV) {
					logger.log(`Session switched to ${data.sessionId}`);
				}
				break;

			case "download_progress":
				if (data.data) {
					window.dispatchEvent(new CustomEvent("download-progress", { detail: data.data }));
				}
				break;
		}
	} catch (error) {
		logger.error("WebSocket message parse error:", error);
		useChatStore.getState().setError("Failed to parse server message");
	}
}
