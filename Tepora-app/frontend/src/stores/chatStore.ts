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
	addUserMessage: (
		content: string,
		mode: ChatMode,
		attachments?: Attachment[],
	) => void;
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

			addUserMessage: (content, mode, _attachments) => {
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

				// If node changed, flush existing buffer first
				if (currentMetadata && currentMetadata.nodeId !== metadata.nodeId) {
					get().flushStreamBuffer();

					// Close the previous streaming message
					set(
						(s) => {
							const lastMessage = s.messages[s.messages.length - 1];
							if (
								lastMessage?.role === "assistant" &&
								!lastMessage.isComplete
							) {
								return {
									messages: [
										...s.messages.slice(0, -1),
										{ ...lastMessage, isComplete: true },
									],
								};
							}
							return {};
						},
						false,
						"closeStreamMessage",
					);

					// Start new message for new node
					const newMessage: Message = {
						id: Date.now().toString(),
						role: "assistant",
						content,
						timestamp: new Date(),
						isComplete: false,
						...metadata,
					};
					set(
						(s) => ({
							messages: [...s.messages, newMessage],
							_streamMetadata: metadata,
							_streamBuffer: "",
						}),
						false,
						"startNewStreamMessage",
					);
					return;
				}

				// Same node - buffer the content
				const newBuffer = state._streamBuffer + content;

				// Clear existing timeout
				if (state._flushTimeout) {
					clearTimeout(state._flushTimeout);
				}

				// Set new timeout for flush
				const timeout = setTimeout(() => {
					get().flushStreamBuffer();
				}, CHUNK_FLUSH_INTERVAL);

				set(
					{
						_streamBuffer: newBuffer,
						_streamMetadata: metadata,
						_flushTimeout: timeout,
					},
					false,
					"bufferChunk",
				);
			},

			flushStreamBuffer: () => {
				const state = get();
				if (!state._streamBuffer) return;

				const bufferedContent = state._streamBuffer;
				const metadata = state._streamMetadata;

				set(
					(s) => {
						const lastMessage = s.messages[s.messages.length - 1];

						// Append to existing streaming message
						if (
							lastMessage?.role === "assistant" &&
							!lastMessage.isComplete &&
							lastMessage.nodeId === metadata?.nodeId
						) {
							return {
								messages: [
									...s.messages.slice(0, -1),
									{
										...lastMessage,
										content: lastMessage.content + bufferedContent,
										mode: metadata?.mode || lastMessage.mode,
									},
								],
								_streamBuffer: "",
								_flushTimeout: null,
							};
						}

						// Start new streaming message
						const newMessage: Message = {
							id: Date.now().toString(),
							role: "assistant",
							content: bufferedContent,
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
