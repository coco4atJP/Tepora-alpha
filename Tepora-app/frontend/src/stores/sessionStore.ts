/**
 * Session Store - Zustand store for session management
 *
 * This store manages:
 * - Current active session
 * - Session list (synced with React Query)
 * - History loading state
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Session } from "../types";

// Re-export Session type for convenience
export type { Session } from "../types";

// ============================================================================
// Types
// ============================================================================

interface SessionState {
	// State
	currentSessionId: string;
	sessions: Session[];
	isLoadingHistory: boolean;
}

interface SessionActions {
	// Session selection
	setCurrentSession: (sessionId: string) => void;

	// Session list management (typically synced with React Query)
	setSessions: (sessions: Session[]) => void;
	addSession: (session: Session) => void;
	removeSession: (sessionId: string) => void;
	updateSession: (sessionId: string, updates: Partial<Session>) => void;

	// History loading state
	setIsLoadingHistory: (isLoading: boolean) => void;

	// Reset to default session
	resetToDefault: () => void;
}

export type SessionStore = SessionState & SessionActions;

// ============================================================================
// Initial State
// ============================================================================

const initialState: SessionState = {
	currentSessionId: "default",
	sessions: [],
	isLoadingHistory: false,
};

// ============================================================================
// Store
// ============================================================================

export const useSessionStore = create<SessionStore>()(
	devtools(
		persist(
			(set, _get) => ({
				...initialState,

				// ------------------------------------------------------------------
				// Session Selection
				// ------------------------------------------------------------------

				setCurrentSession: (sessionId) => {
					set(
						{
							currentSessionId: sessionId,
							isLoadingHistory: true,
						},
						false,
						"setCurrentSession",
					);
				},

				// ------------------------------------------------------------------
				// Session List Management
				// ------------------------------------------------------------------

				setSessions: (sessions) => {
					set({ sessions }, false, "setSessions");
				},

				addSession: (session) => {
					set(
						(state) => ({
							sessions: [session, ...state.sessions],
						}),
						false,
						"addSession",
					);
				},

				removeSession: (sessionId) => {
					set(
						(state) => ({
							sessions: state.sessions.filter((s) => s.id !== sessionId),
							// Reset to default if current session is deleted
							currentSessionId:
								state.currentSessionId === sessionId
									? "default"
									: state.currentSessionId,
						}),
						false,
						"removeSession",
					);
				},

				updateSession: (sessionId, updates) => {
					set(
						(state) => ({
							sessions: state.sessions.map((s) =>
								s.id === sessionId ? { ...s, ...updates } : s,
							),
						}),
						false,
						"updateSession",
					);
				},

				// ------------------------------------------------------------------
				// History Loading State
				// ------------------------------------------------------------------

				setIsLoadingHistory: (isLoadingHistory) => {
					set({ isLoadingHistory }, false, "setIsLoadingHistory");
				},

				// ------------------------------------------------------------------
				// Reset
				// ------------------------------------------------------------------

				resetToDefault: () => {
					set(
						{
							currentSessionId: "default",
							isLoadingHistory: false,
						},
						false,
						"resetToDefault",
					);
				},
			}),
			{
				name: "tepora-session-store",
				// Only persist currentSessionId, not the full session list
				partialize: (state) => ({
					currentSessionId: state.currentSessionId,
				}),
			},
		),
		{ name: "session-store" },
	),
);
