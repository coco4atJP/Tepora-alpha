import { assign, setup } from "xstate";

export interface ChatFlowContext {
	activeRequestId: string | null;
	activeStreamId: string | null;
	pendingToolRequestId: string | null;
	stopRequested: boolean;
	lastError: string | null;
}

export type ChatFlowEvent =
	| { type: "SEND"; requestId: string }
	| { type: "REGENERATE"; requestId: string }
	| { type: "STREAM_EVENT"; streamId?: string | null }
	| { type: "TOOL_CONFIRMATION_REQUIRED"; requestId: string }
	| { type: "TOOL_CONFIRMATION_RESOLVED" }
	| { type: "DONE" }
	| { type: "STOP_REQUESTED" }
	| { type: "STOPPED" }
	| { type: "FAILED"; message: string }
	| { type: "RESET" }
	| { type: "SESSION_CHANGED" }
	| { type: "RECONNECT_INVALIDATED" };

const emptyContext: ChatFlowContext = {
	activeRequestId: null,
	activeStreamId: null,
	pendingToolRequestId: null,
	stopRequested: false,
	lastError: null,
};

export const chatFlowMachine = setup({
	types: {
		context: {} as ChatFlowContext,
		events: {} as ChatFlowEvent,
	},
	actions: {
		beginSend: assign(({ event }) => {
			if (event.type !== "SEND" && event.type !== "REGENERATE") {
				return {};
			}

			return {
				activeRequestId: event.requestId,
				activeStreamId: null,
				pendingToolRequestId: null,
				stopRequested: false,
				lastError: null,
			};
		}),
		captureStream: assign(({ event }) => {
			if (event.type !== "STREAM_EVENT") {
				return {};
			}

			return {
				activeStreamId: event.streamId ?? null,
				pendingToolRequestId: null,
				stopRequested: false,
			};
		}),
		rememberToolRequest: assign(({ event }) => {
			if (event.type !== "TOOL_CONFIRMATION_REQUIRED") {
				return {};
			}

			return {
				pendingToolRequestId: event.requestId,
			};
		}),
		clearToolRequest: assign({
			pendingToolRequestId: null,
		}),
		markStopRequested: assign({
			stopRequested: true,
		}),
		rememberFailure: assign(({ event }) => {
			if (event.type !== "FAILED") {
				return {};
			}

			return {
				lastError: event.message,
				pendingToolRequestId: null,
			};
		}),
		settleFlow: assign({
			activeRequestId: null,
			activeStreamId: null,
			pendingToolRequestId: null,
			stopRequested: false,
		}),
		resetContext: assign(() => ({
			...emptyContext,
		})),
	},
}).createMachine({
	id: "chatFlowV2",
	initial: "idle",
	context: emptyContext,
	states: {
		idle: {
			on: {
				SEND: {
					target: "sending",
					actions: "beginSend",
				},
				REGENERATE: {
					target: "sending",
					actions: "beginSend",
				},
			},
		},
		sending: {
			on: {
				STREAM_EVENT: {
					target: "streaming",
					actions: "captureStream",
				},
				TOOL_CONFIRMATION_REQUIRED: {
					target: "awaitingToolConfirmation",
					actions: "rememberToolRequest",
				},
				DONE: {
					target: "completed",
					actions: "settleFlow",
				},
				STOP_REQUESTED: {
					actions: "markStopRequested",
				},
				STOPPED: {
					target: "stopped",
					actions: "settleFlow",
				},
				FAILED: {
					target: "error",
					actions: "rememberFailure",
				},
			},
		},
		streaming: {
			on: {
				STREAM_EVENT: {
					target: "streaming",
					actions: "captureStream",
				},
				TOOL_CONFIRMATION_REQUIRED: {
					target: "awaitingToolConfirmation",
					actions: "rememberToolRequest",
				},
				DONE: {
					target: "completed",
					actions: "settleFlow",
				},
				STOP_REQUESTED: {
					actions: "markStopRequested",
				},
				STOPPED: {
					target: "stopped",
					actions: "settleFlow",
				},
				FAILED: {
					target: "error",
					actions: "rememberFailure",
				},
			},
		},
		awaitingToolConfirmation: {
			on: {
				TOOL_CONFIRMATION_RESOLVED: {
					target: "sending",
					actions: "clearToolRequest",
				},
				STOP_REQUESTED: {
					actions: "markStopRequested",
				},
				STOPPED: {
					target: "stopped",
					actions: "settleFlow",
				},
				FAILED: {
					target: "error",
					actions: "rememberFailure",
				},
			},
		},
		completed: {
			on: {
				SEND: {
					target: "sending",
					actions: "beginSend",
				},
				REGENERATE: {
					target: "sending",
					actions: "beginSend",
				},
			},
		},
		stopped: {
			on: {
				SEND: {
					target: "sending",
					actions: "beginSend",
				},
				REGENERATE: {
					target: "sending",
					actions: "beginSend",
				},
			},
		},
		error: {
			on: {
				SEND: {
					target: "sending",
					actions: "beginSend",
				},
				REGENERATE: {
					target: "sending",
					actions: "beginSend",
				},
			},
		},
	},
	on: {
		RESET: {
			target: ".idle",
			actions: "resetContext",
		},
		SESSION_CHANGED: {
			target: ".idle",
			actions: "resetContext",
		},
		RECONNECT_INVALIDATED: {
			target: ".stopped",
			actions: ["markStopRequested", "clearToolRequest", "settleFlow"],
		},
	},
});
