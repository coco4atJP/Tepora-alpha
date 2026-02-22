/**
 * Chat Store - Zustand store for chat messages and streaming state
 *
 * This store manages:
 * - Chat messages (user, assistant, system)
 * - Streaming message buffering
 * - Activity log for agent processing
 * - Search results
 * - Error state
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
	AgentActivity,
	Attachment,
	ChatMode,
	MemoryStats,
	Message,
	SearchResult,
} from "../types";

// ============================================================================
// Types
// ============================================================================

/** Metadata carried alongside each streaming chunk. */
export interface StreamingMetadata {
	mode?: ChatMode;
	agentName?: string;
	nodeId?: string;
}

/**
 * Consolidated streaming state object.
 * Groups the three previously separate streaming-related fields into one cohesive structure.
 */
export interface StreamingState {
	/** Accumulated text waiting to be flushed into the message list. */
	buffer: string;
	/** Metadata of the stream currently in progress (null if idle). */
	metadata: StreamingMetadata | null;
	/** Handle for the debounce timer that triggers the next flush. */
	flushTimeout: ReturnType<typeof setTimeout> | null;
}

interface ChatState {
	// State
	messages: Message[];
	isProcessing: boolean;
	error: string | null;
	activityLog: AgentActivity[];
	searchResults: SearchResult[];
	memoryStats: MemoryStats | null;

	/**
	 * Consolidated streaming state.
	 * Exposed via the `streaming` field; the legacy `_stream*` aliases below
	 * are kept for backward compatibility with existing selectors / tests.
	 */
	streaming: StreamingState;

	// Legacy aliases kept for backward compatibility (point into `streaming`)
	_streamBuffer: string;
	_streamMetadata: StreamingMetadata | null;
	_flushTimeout: ReturnType<typeof setTimeout> | null;
}

interface ChatActions {
	// Message actions
	addMessage: (message: Message) => void;
	addUserMessage: (content: string, mode: ChatMode, attachments?: Attachment[]) => void;
	setMessages: (messages: Message[]) => void;
	clearMessages: () => void;

	// Streaming actions
	handleStreamChunk: (content: string, metadata: StreamingMetadata) => void;
	flushStreamBuffer: () => void;
	finalizeStream: () => void;

	// Processing state
	setIsProcessing: (isProcessing: boolean) => void;

	// Error state
	setError: (error: string | null) => void;
	clearError: () => void;

	// Activity log
	updateActivity: (activity: AgentActivity) => void;
	clearActivityLog: () => void;

	// Search results
	setSearchResults: (results: SearchResult[]) => void;

	// Memory stats
	setMemoryStats: (stats: MemoryStats | null) => void;

	// Reset
	reset: () => void;
}

export type ChatStore = ChatState & ChatActions;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CHUNK_FLUSH_INTERVAL = 50;
const DEFAULT_CHUNK_FLUSH_INTERVAL_MIN = 20;
const DEFAULT_CHUNK_FLUSH_INTERVAL_MAX = 140;

const parseFlushInterval = (value: string | undefined, fallback: number): number => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return Math.round(parsed);
};

const BASE_CHUNK_FLUSH_INTERVAL = parseFlushInterval(
	import.meta.env.VITE_CHUNK_FLUSH_INTERVAL,
	DEFAULT_CHUNK_FLUSH_INTERVAL,
);
const MIN_CHUNK_FLUSH_INTERVAL = parseFlushInterval(
	import.meta.env.VITE_CHUNK_FLUSH_INTERVAL_MIN,
	DEFAULT_CHUNK_FLUSH_INTERVAL_MIN,
);
const MAX_CHUNK_FLUSH_INTERVAL = Math.max(
	MIN_CHUNK_FLUSH_INTERVAL,
	parseFlushInterval(
		import.meta.env.VITE_CHUNK_FLUSH_INTERVAL_MAX,
		DEFAULT_CHUNK_FLUSH_INTERVAL_MAX,
	),
);

type NetworkHint = {
	effectiveType?: string;
	rtt?: number;
	saveData?: boolean;
};

const resolveNetworkHint = (): NetworkHint | null => {
	if (typeof navigator === "undefined") {
		return null;
	}

	const nav = navigator as Navigator & {
		connection?: NetworkHint;
		mozConnection?: NetworkHint;
		webkitConnection?: NetworkHint;
	};

	return nav.connection || nav.mozConnection || nav.webkitConnection || null;
};

const clampFlushInterval = (value: number): number =>
	Math.min(MAX_CHUNK_FLUSH_INTERVAL, Math.max(MIN_CHUNK_FLUSH_INTERVAL, Math.round(value)));

const computeChunkFlushInterval = (chunkLength: number): number => {
	let interval = BASE_CHUNK_FLUSH_INTERVAL;
	const hint = resolveNetworkHint();

	if (hint?.saveData) {
		interval += 20;
	}

	switch (hint?.effectiveType) {
		case "slow-2g":
			interval += 50;
			break;
		case "2g":
			interval += 35;
			break;
		case "3g":
			interval += 15;
			break;
		case "4g":
			interval -= 5;
			break;
		default:
			break;
	}

	const rtt = hint?.rtt;
	if (typeof rtt === "number") {
		if (rtt >= 300) {
			interval += 20;
		} else if (rtt >= 180) {
			interval += 10;
		} else if (rtt <= 80) {
			interval -= 5;
		}
	}

	if (chunkLength <= 12) {
		interval += 10;
	} else if (chunkLength >= 160) {
		interval -= 10;
	}

	return clampFlushInterval(interval);
};

const createStreamingState = (
	buffer = "",
	metadata: StreamingMetadata | null = null,
	flushTimeout: ReturnType<typeof setTimeout> | null = null,
): StreamingState => ({
	buffer,
	metadata,
	flushTimeout,
});

const toStreamingAliases = (streaming: StreamingState) => ({
	streaming,
	_streamBuffer: streaming.buffer,
	_streamMetadata: streaming.metadata,
	_flushTimeout: streaming.flushTimeout,
});

const patchStreamingState = (state: ChatState, patch: Partial<StreamingState>) => {
	const streaming = createStreamingState(
		patch.buffer ?? state.streaming.buffer,
		patch.metadata !== undefined ? patch.metadata : state.streaming.metadata,
		patch.flushTimeout !== undefined ? patch.flushTimeout : state.streaming.flushTimeout,
	);
	return toStreamingAliases(streaming);
};

// ============================================================================
// Initial State
// ============================================================================

const initialStreamingState = createStreamingState();

const initialState: ChatState = {
	messages: [],
	isProcessing: false,
	error: null,
	activityLog: [],
	searchResults: [],
	memoryStats: null,
	...toStreamingAliases(initialStreamingState),
};

// ============================================================================
// Store
// ============================================================================

export const useChatStore = create<ChatStore>()(
	devtools(
		(set, get) => ({
			...initialState,

			// ------------------------------------------------------------------
			// Message Actions
			// ------------------------------------------------------------------

			addMessage: (message) => {
				set(
					(state) => ({
						messages: [...state.messages, message],
					}),
					false,
					"addMessage",
				);
			},

			addUserMessage: (content, mode) => {
				const message: Message = {
					id: Date.now().toString(),
					role: "user",
					content,
					timestamp: new Date(),
					mode,
				};
				set(
					(state) => ({
						messages: [...state.messages, message],
						activityLog: [], // Clear activity log on new message
						error: null,
					}),
					false,
					"addUserMessage",
				);
			},

			setMessages: (messages) => {
				set({ messages }, false, "setMessages");
			},

			clearMessages: () => {
				const state = get();
				if (state.streaming.flushTimeout) {
					clearTimeout(state.streaming.flushTimeout);
				}
				set(
					(s) => ({
						messages: [],
						searchResults: [],
						activityLog: [],
						error: null,
						...patchStreamingState(s, createStreamingState()),
					}),
					false,
					"clearMessages",
				);
			},

			// ------------------------------------------------------------------
			// Streaming Actions
			// ------------------------------------------------------------------

			handleStreamChunk: (content, metadata) => {
				const state = get();
				const currentMetadata = state.streaming.metadata;

				// Special handling for Thinking -> Response transition:
				// If we are switching nodes, but staying within the same "Response" lifecycle (e.g. Thinking -> Final Answer),
				// we should NOT close the stream, but instead flush the buffer to the appropriate field and switch target.

				const isThinkingNode = (id?: string) => id === "thinking";

				// Check if we should split the message (standard behavior) or keep merged (transactional behavior)
				// We merge if:
				// - Current was Thinking, New is NOT Thinking (Thinking -> Answer)
				// - We are already streaming and just switching generic nodes (legacy behavior might separate them, but let's try to keep them together if role is assistant)

				// Simplified Logic:
				// If nodeId changes, we flush the buffer.
				// If the message is NOT complete, we check if we can continue appending to it (different field).

				// Check if node changed
				if (currentMetadata && currentMetadata.nodeId !== metadata.nodeId) {
					// FLUSH current buffer before switching
					get().flushStreamBuffer();

					const lastMessage = state.messages[state.messages.length - 1];

					// Decision: Do we close the current message or continue it?
					// Continue if: Last message is assistant, not complete, and we are just switching phases (e.g. Thinking -> Answer)
					const shouldContinueMessage =
						lastMessage?.role === "assistant" &&
						!lastMessage.isComplete &&
						(isThinkingNode(currentMetadata.nodeId) || isThinkingNode(metadata.nodeId));

					if (shouldContinueMessage) {
						// We are keeping the same message, just updating metadata so future chunks go to right place
						set(
							(s) => patchStreamingState(s, { metadata, buffer: "" }),
							false,
							"switchStreamNode",
						);
						return;
					}

					// Standard behavior: Close previous message
					set(
						(s) => {
							const msg = s.messages[s.messages.length - 1];
							if (msg?.role === "assistant" && !msg.isComplete) {
								return {
									messages: [...s.messages.slice(0, -1), { ...msg, isComplete: true }],
								};
							}
							return {};
						},
						false,
						"closeStreamMessage",
					);

					// Start new message
					const newMessage: Message = {
						id: Date.now().toString(),
						role: "assistant",
						content: isThinkingNode(metadata.nodeId) ? "" : content,
						thinking: isThinkingNode(metadata.nodeId) ? content : undefined,
						timestamp: new Date(),
						isComplete: false,
						...metadata,
					};

					set(
						(s) => ({
							messages: [...s.messages, newMessage],
							...patchStreamingState(s, { metadata, buffer: "" }), // Content already added to newMessage
						}),
						false,
						"startNewStreamMessage",
					);
					return;
				}

				// SAME NODE - buffer the content
				const newBuffer = state.streaming.buffer + content;

				if (state.streaming.flushTimeout) {
					clearTimeout(state.streaming.flushTimeout);
				}

				const flushInterval = computeChunkFlushInterval(content.length);
				const timeout = setTimeout(() => {
					get().flushStreamBuffer();
				}, flushInterval);

				set(
					(s) =>
						patchStreamingState(s, {
							buffer: newBuffer,
							metadata, // Ensure metadata is set
							flushTimeout: timeout,
						}),
					false,
					"bufferChunk",
				);
			},

			flushStreamBuffer: () => {
				const state = get();
				if (!state.streaming.buffer && !state.streaming.metadata) return;

				const bufferedContent = state.streaming.buffer;
				const metadata = state.streaming.metadata;
				const isThinking = metadata?.nodeId === "thinking";

				set(
					(s) => {
						const lastMessage = s.messages[s.messages.length - 1];

						// Append to existing streaming message
						if (lastMessage?.role === "assistant" && !lastMessage.isComplete) {
							// Check if we should append to thinking or content based on CURRENT metadata
							// Note: We use the metadata from store because that tracks where the buffer belongs

							return {
								messages: [
									...s.messages.slice(0, -1),
									{
										...lastMessage,
										content: isThinking
											? lastMessage.content
											: lastMessage.content + bufferedContent,
										thinking: isThinking
											? (lastMessage.thinking || "") + bufferedContent
											: lastMessage.thinking,
										// Update top-level mode/agentName if changed
										mode: metadata?.mode || lastMessage.mode,
										agentName: metadata?.agentName || lastMessage.agentName,
										nodeId: metadata?.nodeId || lastMessage.nodeId,
									},
								],
								...patchStreamingState(s, { buffer: "", flushTimeout: null }),
							};
						}

						// Start new streaming message (Fallback if no active message found)
						const newMessage: Message = {
							id: Date.now().toString(),
							role: "assistant",
							content: isThinking ? "" : bufferedContent,
							thinking: isThinking ? bufferedContent : undefined,
							timestamp: new Date(),
							isComplete: false,
							...metadata,
						};

						return {
							messages: [...s.messages, newMessage],
							...patchStreamingState(s, { buffer: "", flushTimeout: null }),
						};
					},
					false,
					"flushBuffer",
				);
			},

			finalizeStream: () => {
				const state = get();

				// Clear any pending timeout
				if (state.streaming.flushTimeout) {
					clearTimeout(state.streaming.flushTimeout);
				}

				// Flush remaining buffer and mark message as complete
				set(
					(s) => {
						const lastMessage = s.messages[s.messages.length - 1];
						if (lastMessage?.role === "assistant") {
							const remainingContent = s.streaming.buffer;
							return {
								messages: [
									...s.messages.slice(0, -1),
									{
										...lastMessage,
										content: lastMessage.content + remainingContent,
										isComplete: true,
									},
								],
								...patchStreamingState(s, createStreamingState()),
							};
						}
						return patchStreamingState(s, createStreamingState());
					},
					false,
					"finalizeStream",
				);
			},

			// ------------------------------------------------------------------
			// Processing State
			// ------------------------------------------------------------------

			setIsProcessing: (isProcessing) => {
				set({ isProcessing }, false, "setIsProcessing");
			},

			// ------------------------------------------------------------------
			// Error State
			// ------------------------------------------------------------------

			setError: (error) => {
				set({ error }, false, "setError");
			},

			clearError: () => {
				set({ error: null }, false, "clearError");
			},

			// ------------------------------------------------------------------
			// Activity Log
			// ------------------------------------------------------------------

			updateActivity: (activity) => {
				set(
					(state) => {
						const existingIndex = state.activityLog.findIndex(
							(a) => a.agent_name === activity.agent_name,
						);

						if (existingIndex !== -1) {
							const newLog = [...state.activityLog];
							newLog[existingIndex] = activity;
							return { activityLog: newLog };
						}

						return {
							activityLog: [
								...state.activityLog,
								{ ...activity, step: state.activityLog.length + 1 },
							],
						};
					},
					false,
					"updateActivity",
				);
			},

			clearActivityLog: () => {
				set({ activityLog: [] }, false, "clearActivityLog");
			},

			// ------------------------------------------------------------------
			// Search Results
			// ------------------------------------------------------------------

			setSearchResults: (searchResults) => {
				set({ searchResults }, false, "setSearchResults");
			},

			// ------------------------------------------------------------------
			// Memory Stats
			// ------------------------------------------------------------------

			setMemoryStats: (memoryStats) => {
				set({ memoryStats }, false, "setMemoryStats");
			},

			// ------------------------------------------------------------------
			// Reset
			// ------------------------------------------------------------------

			reset: () => {
				const state = get();
				if (state.streaming.flushTimeout) {
					clearTimeout(state.streaming.flushTimeout);
				}
				set(initialState, false, "reset");
			},
		}),
		{ name: "chat-store" },
	),
);
