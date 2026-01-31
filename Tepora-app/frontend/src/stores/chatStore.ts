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

interface StreamingMetadata {
	mode?: ChatMode;
	agentName?: string;
	nodeId?: string;
}

interface ChatState {
	// State
	messages: Message[];
	isProcessing: boolean;
	error: string | null;
	activityLog: AgentActivity[];
	searchResults: SearchResult[];
	memoryStats: MemoryStats | null;

	// Streaming buffer state (internal)
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

const CHUNK_FLUSH_INTERVAL = 50; // ms

// ============================================================================
// Initial State
// ============================================================================

const initialState: ChatState = {
	messages: [],
	isProcessing: false,
	error: null,
	activityLog: [],
	searchResults: [],
	memoryStats: null,
	_streamBuffer: "",
	_streamMetadata: null,
	_flushTimeout: null,
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
				set(
					{
						messages: [],
						searchResults: [],
						activityLog: [],
						error: null,
					},
					false,
					"clearMessages",
				);
			},

			// ------------------------------------------------------------------
			// Streaming Actions
			// ------------------------------------------------------------------

			handleStreamChunk: (content, metadata) => {
				const state = get();
				const currentMetadata = state._streamMetadata;

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
							{
								_streamMetadata: metadata,
								_streamBuffer: "",
							},
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
							_streamMetadata: metadata,
							_streamBuffer: "", // Content already added to newMessage
						}),
						false,
						"startNewStreamMessage",
					);
					return;
				}

				// SAME NODE - buffer the content
				const newBuffer = state._streamBuffer + content;

				if (state._flushTimeout) {
					clearTimeout(state._flushTimeout);
				}

				const timeout = setTimeout(() => {
					get().flushStreamBuffer();
				}, CHUNK_FLUSH_INTERVAL);

				set(
					{
						_streamBuffer: newBuffer,
						_streamMetadata: metadata, // Ensure metadata is set
						_flushTimeout: timeout,
					},
					false,
					"bufferChunk",
				);
			},

			flushStreamBuffer: () => {
				const state = get();
				if (!state._streamBuffer && !state._streamMetadata) return;

				const bufferedContent = state._streamBuffer;
				const metadata = state._streamMetadata;
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
								_streamBuffer: "",
								_flushTimeout: null,
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
							_streamBuffer: "",
							_flushTimeout: null,
						};
					},
					false,
					"flushBuffer",
				);
			},

			finalizeStream: () => {
				const state = get();

				// Clear any pending timeout
				if (state._flushTimeout) {
					clearTimeout(state._flushTimeout);
				}

				// Flush remaining buffer and mark message as complete
				set(
					(s) => {
						const lastMessage = s.messages[s.messages.length - 1];
						if (lastMessage?.role === "assistant") {
							const remainingContent = s._streamBuffer;
							return {
								messages: [
									...s.messages.slice(0, -1),
									{
										...lastMessage,
										content: lastMessage.content + remainingContent,
										isComplete: true,
									},
								],
								_streamBuffer: "",
								_streamMetadata: null,
								_flushTimeout: null,
							};
						}
						return {
							_streamBuffer: "",
							_streamMetadata: null,
							_flushTimeout: null,
						};
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
				if (state._flushTimeout) {
					clearTimeout(state._flushTimeout);
				}
				set(initialState, false, "reset");
			},
		}),
		{ name: "chat-store" },
	),
);
