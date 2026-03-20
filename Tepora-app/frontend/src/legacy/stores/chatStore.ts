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

interface ChatState {
	// State
	messages: Message[];
	error: string | null;
	activityLog: AgentActivity[];
	searchResults: SearchResult[];
	memoryStats: MemoryStats | null;
	isGeneratingMemory: boolean;
}

interface ChatActions {
	// Message actions
	addMessage: (message: Message) => void;
	addUserMessage: (content: string, mode: ChatMode, attachments?: Attachment[]) => void;
	setMessages: (messages: Message[]) => void;
	clearMessages: () => void;

	// Generating Memory State
	setIsGeneratingMemory: (isGenerating: boolean) => void;

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

	// Thought process
	updateMessageThinking: (thinking: string) => void;

	// Reset
	reset: () => void;
}

export type ChatStore = ChatState & ChatActions;

// ============================================================================
// Initial State
// ============================================================================

const initialState: ChatState = {
	messages: [],
	error: null,
	activityLog: [],
	searchResults: [],
	memoryStats: null,
	isGeneratingMemory: false,
};

// ============================================================================
// Store
// ============================================================================

export const useChatStore = create<ChatStore>()(
	devtools(
		(set) => ({
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
					() => ({
						messages: [],
						searchResults: [],
						activityLog: [],
						error: null,
					}),
					false,
					"clearMessages",
				);
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
			// Generating Memory State
			// ------------------------------------------------------------------

			setIsGeneratingMemory: (isGeneratingMemory) => {
				set({ isGeneratingMemory }, false, "setIsGeneratingMemory");
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
			// Thought Process
			// ------------------------------------------------------------------

			updateMessageThinking: (thinking) => {
				set(
					(state) => {
						const lastMsg = state.messages[state.messages.length - 1];
						if (lastMsg && lastMsg.role === "assistant") {
							const newMessages = [...state.messages];
							newMessages[state.messages.length - 1] = { ...lastMsg, thinking };
							return { messages: newMessages };
						}
						// Create a new assistant message if none exists
						const newMessage: Message = {
							id: Date.now().toString(),
							role: "assistant",
							content: "",
							thinking,
							timestamp: new Date(),
							isComplete: false,
						};
						return { messages: [...state.messages, newMessage] };
					},
					false,
					"updateMessageThinking",
				);
			},

			// ------------------------------------------------------------------
			// Reset
			// ------------------------------------------------------------------

			reset: () => {
				set(initialState, false, "reset");
			},
		}),
		{ name: "chat-store" },
	),
);
