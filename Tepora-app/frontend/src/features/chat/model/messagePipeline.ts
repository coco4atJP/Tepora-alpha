import type {
	SessionHistoryMessage,
	ToolConfirmationRequest,
	V2WsIncomingMessage,
} from "../../../shared/contracts";
import type {
	ChatActivityItemViewModel,
	ChatMessageViewModel,
	ChatToolConfirmationViewModel,
} from "../view/props";

interface ChatStreamState {
	nextSeq: number;
	buffer: Record<number, V2WsIncomingMessage>;
	assistantMessageId: string | null;
}

export interface ChatPipelineState {
	messages: ChatMessageViewModel[];
	pendingToolConfirmation: ChatToolConfirmationViewModel | null;
	statusMessage: string | null;
	activity: ChatActivityItemViewModel[];
	streams: Record<string, ChatStreamState>;
	seenEventIds: Record<string, true>;
}

export type ChatPipelineAction =
	| { type: "RESET" }
	| { type: "HYDRATE_HISTORY"; messages: SessionHistoryMessage[] }
	| {
			type: "APPEND_OPTIMISTIC_USER";
			message: {
				id: string;
				content: string;
				createdAt: string;
				mode: ChatMessageViewModel["mode"];
			};
		}
	| { type: "TRANSPORT_MESSAGE"; message: V2WsIncomingMessage }
	| { type: "CLEAR_TOOL_CONFIRMATION" };

function createStreamState(): ChatStreamState {
	return {
		nextSeq: 1,
		buffer: {},
		assistantMessageId: null,
	};
}

export function createInitialChatPipelineState(): ChatPipelineState {
	return {
		messages: [],
		pendingToolConfirmation: null,
		statusMessage: null,
		activity: [],
		streams: {},
		seenEventIds: {},
	};
}

export function mapHistoryMessagesToViewModels(
	messages: SessionHistoryMessage[],
): ChatMessageViewModel[] {
	return messages.map((message) => ({
		id: message.id,
		role: message.role,
		content: message.content,
		thinking: null,
		createdAt: message.timestamp,
		status: message.isComplete === false ? "streaming" : "complete",
		mode: message.mode,
	}));
}

function stringifyToolArgs(toolArgs: ToolConfirmationRequest["toolArgs"]): string {
	try {
		return JSON.stringify(toolArgs, null, 2);
	} catch {
		return "{}";
	}
}

function toToolConfirmationViewModel(
	request: ToolConfirmationRequest,
): ChatToolConfirmationViewModel {
	return {
		requestId: request.requestId,
		toolName: request.toolName,
		description: request.description,
		riskLevel: request.riskLevel,
		scopeLabel: `${request.scope}: ${request.scopeName}`,
		argsPreview: stringifyToolArgs(request.toolArgs),
		expiryOptions: request.expiryOptions,
	};
}

function updateMessage(
	messages: ChatMessageViewModel[],
	messageId: string,
	updater: (message: ChatMessageViewModel) => ChatMessageViewModel,
): ChatMessageViewModel[] {
	return messages.map((message) =>
		message.id === messageId ? updater(message) : message,
	);
}

function ensureAssistantMessage(
	state: ChatPipelineState,
	streamId: string,
	message: V2WsIncomingMessage,
): ChatPipelineState {
	const stream = state.streams[streamId] ?? createStreamState();
	if (stream.assistantMessageId) {
		return state;
	}

	const assistantMessageId = `assistant:${streamId}`;
	const nextMessages = [...state.messages];
	nextMessages.push({
		id: assistantMessageId,
		role: "assistant",
		content: "",
		thinking: null,
		createdAt: message.emittedAt ?? new Date().toISOString(),
		status: "streaming",
		mode: message.type === "chunk" ? message.mode : undefined,
		agentName: message.type === "chunk" ? message.agentName : undefined,
		nodeId:
			message.type === "chunk" ? message.nodeId : undefined,
	});

	return {
		...state,
		messages: nextMessages,
		streams: {
			...state.streams,
			[streamId]: {
				...stream,
				assistantMessageId,
			},
		},
	};
}

function finalizeStream(
	state: ChatPipelineState,
	streamId: string,
	status: ChatMessageViewModel["status"],
): ChatPipelineState {
	const stream = state.streams[streamId];
	if (!stream?.assistantMessageId) {
		const { [streamId]: _removed, ...remainingStreams } = state.streams;
		return {
			...state,
			streams: remainingStreams,
		};
	}

	const { [streamId]: _removed, ...remainingStreams } = state.streams;
	return {
		...state,
		messages: updateMessage(state.messages, stream.assistantMessageId, (message) => ({
			...message,
			status,
		})),
		streams: remainingStreams,
	};
}

function applyMessageImmediately(
	state: ChatPipelineState,
	message: V2WsIncomingMessage,
): ChatPipelineState {
	if (message.type === "history") {
		return {
			...state,
			messages: mapHistoryMessagesToViewModels(message.messages),
			streams: {},
		};
	}

	if (message.type === "status") {
		return {
			...state,
			statusMessage: message.message,
		};
	}

	if (message.type === "activity") {
		const nextItem: ChatActivityItemViewModel = {
			id: message.data.id,
			status:
				message.data.status === "done"
					? "done"
					: message.data.status === "error"
						? "error"
						: message.data.status === "pending"
							? "pending"
							: "processing",
			label: message.data.message,
			agentName: message.data.agentName,
		};
		const filtered = state.activity.filter((item) => item.id !== nextItem.id);
		return {
			...state,
			activity: [...filtered, nextItem].slice(-12),
		};
	}

	if (message.type === "tool_confirmation_request") {
		return {
			...state,
			pendingToolConfirmation: toToolConfirmationViewModel(message.data),
		};
	}

	if (!message.streamId) {
		if (message.type === "error") {
			return {
				...state,
				statusMessage: message.message,
				messages: [
					...state.messages,
					{
						id: `system:${Date.now()}`,
						role: "system",
						content: message.message,
						thinking: null,
						createdAt: message.emittedAt ?? new Date().toISOString(),
						status: "error",
					},
				],
			};
		}

		return state;
	}

	const streamId = message.streamId;
	const nextSeq =
		typeof message.seq === "number"
			? message.seq + 1
			: state.streams[streamId]?.nextSeq ?? 1;
	let nextState = {
		...state,
		streams: {
			...state.streams,
			[streamId]: {
				...(state.streams[streamId] ?? createStreamState()),
				nextSeq,
			},
		},
	};

	if (message.type === "chunk") {
		nextState = ensureAssistantMessage(nextState, streamId, message);
		const assistantMessageId = nextState.streams[streamId]?.assistantMessageId;
		if (!assistantMessageId) {
			return nextState;
		}

		return {
			...nextState,
			messages: updateMessage(nextState.messages, assistantMessageId, (item) => ({
				...item,
				content: `${item.content}${message.message ?? ""}`,
				mode: message.mode ?? item.mode,
				agentName: message.agentName ?? item.agentName,
				nodeId: message.nodeId ?? item.nodeId,
				status: "streaming",
			})),
		};
	}

	if (message.type === "thought") {
		nextState = ensureAssistantMessage(nextState, streamId, message);
		const assistantMessageId = nextState.streams[streamId]?.assistantMessageId;
		if (!assistantMessageId) {
			return nextState;
		}

		return {
			...nextState,
			messages: updateMessage(nextState.messages, assistantMessageId, (item) => ({
				...item,
				thinking: `${item.thinking ?? ""}${message.content}`,
				status: "streaming",
			})),
		};
	}

	if (message.type === "done") {
		return finalizeStream(nextState, streamId, "complete");
	}

	if (message.type === "stopped") {
		return finalizeStream(nextState, streamId, "stopped");
	}

	if (message.type === "error") {
		return {
			...finalizeStream(nextState, streamId, "error"),
			statusMessage: message.message,
		};
	}

	return nextState;
}

function drainBufferedMessages(
	state: ChatPipelineState,
	streamId: string,
): ChatPipelineState {
	let nextState = state;
	let stream = nextState.streams[streamId];

	while (stream && stream.buffer[stream.nextSeq]) {
		const bufferedMessage = stream.buffer[stream.nextSeq];
		const nextBuffer = { ...stream.buffer };
		delete nextBuffer[stream.nextSeq];
		nextState = {
			...nextState,
			streams: {
				...nextState.streams,
				[streamId]: {
					...stream,
					buffer: nextBuffer,
				},
			},
		};
		nextState = applyMessageImmediately(nextState, bufferedMessage);
		stream = nextState.streams[streamId];
	}

	return nextState;
}

function applySequencedTransportMessage(
	state: ChatPipelineState,
	message: V2WsIncomingMessage,
): ChatPipelineState {
	if (!message.eventId) {
		return applyMessageImmediately(state, message);
	}

	if (state.seenEventIds[message.eventId]) {
		return state;
	}

	const seenEventIds: Record<string, true> = {
		...state.seenEventIds,
		[message.eventId]: true,
	};
	if (!message.streamId || typeof message.seq !== "number") {
		return applyMessageImmediately(
			{
				...state,
				seenEventIds,
			},
			message,
		);
	}

	const stream = state.streams[message.streamId] ?? createStreamState();
	if (message.seq > stream.nextSeq) {
		return {
			...state,
			seenEventIds,
			streams: {
				...state.streams,
				[message.streamId]: {
					...stream,
					buffer: {
						...stream.buffer,
						[message.seq]: message,
					},
				},
			},
		};
	}

	if (message.seq < stream.nextSeq) {
		return {
			...state,
			seenEventIds,
		};
	}

	const immediateState = applyMessageImmediately(
		{
			...state,
			seenEventIds,
		},
		message,
	);
	return drainBufferedMessages(immediateState, message.streamId);
}

export function chatPipelineReducer(
	state: ChatPipelineState,
	action: ChatPipelineAction,
): ChatPipelineState {
	switch (action.type) {
		case "RESET":
			return createInitialChatPipelineState();
		case "HYDRATE_HISTORY":
			return {
				...state,
				messages: mapHistoryMessagesToViewModels(action.messages),
				streams: {},
			};
		case "APPEND_OPTIMISTIC_USER":
			return {
				...state,
				messages: [
					...state.messages,
					{
						id: action.message.id,
						role: "user",
						content: action.message.content,
						thinking: null,
						createdAt: action.message.createdAt,
						status: "complete",
						mode: action.message.mode,
					},
				],
			};
		case "TRANSPORT_MESSAGE":
			return applySequencedTransportMessage(state, action.message);
		case "CLEAR_TOOL_CONFIRMATION":
			return {
				...state,
				pendingToolConfirmation: null,
			};
		default:
			return state;
	}
}

