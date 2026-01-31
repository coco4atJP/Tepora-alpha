/**
 * Session Token Management Module
 *
 * Handles session token retrieval for API and WebSocket authentication.
 * In desktop (Tauri) mode, reads token from file system.
 * In web mode, falls back to environment variable.
 */

import { isDesktop } from "./api";

// Cached token to avoid repeated file reads
let cachedToken: string | null = null;
let tokenLoadPromise: Promise<string | null> | null = null;

/**
 * Read session token from file system (Tauri desktop mode only)
 * Note: Uses invoke API if available, otherwise falls back to environment
 */
async function readTokenFromFile(): Promise<string | null> {
	if (!isDesktop()) {
		return null;
	}

	try {
		// Try to read token using Tauri invoke if a command is registered
		// This approach doesn't require additional plugins
		const { invoke } = await import("@tauri-apps/api/core");
		const token = await invoke<string>("read_session_token");
		return token?.trim() || null;
	} catch {
		// Invoke command not registered or failed - fall back to env
		// This is expected for new installations or web mode
		if (import.meta.env.DEV) {
			console.debug("[SessionToken] Tauri invoke not available, using env fallback");
		}
		return null;
	}
}

/**
 * Get session token from environment variable (web mode fallback)
 */
function getTokenFromEnv(): string | null {
	const token = import.meta.env.VITE_API_KEY || import.meta.env.VITE_SESSION_TOKEN;
	return token || null;
}

/**
 * Store token in window global for synchronous access from getAuthHeaders()
 */
function updateWindowCache(token: string | null): void {
	if (typeof window !== "undefined") {
		(window as unknown as { __tepora_session_token?: string }).__tepora_session_token =
			token ?? undefined;
	}
}

/**
 * Get session token for authentication.
 *
 * Priority:
 * 1. Cached token (if available)
 * 2. File system (Tauri desktop mode)
 * 3. Environment variable (web mode fallback)
 *
 * @returns Promise resolving to session token or null if not available
 */
export async function getSessionToken(): Promise<string | null> {
	// Return cached token if available
	if (cachedToken) {
		return cachedToken;
	}

	// If a load is already in progress, wait for it
	if (tokenLoadPromise) {
		return tokenLoadPromise;
	}

	// Start loading
	tokenLoadPromise = (async () => {
		// Try file system first (desktop mode)
		const fileToken = await readTokenFromFile();
		if (fileToken) {
			cachedToken = fileToken;
			updateWindowCache(cachedToken);
			if (import.meta.env.DEV) {
				console.log("[SessionToken] Loaded from file");
			}
			return cachedToken;
		}

		// Fall back to environment variable
		const envToken = getTokenFromEnv();
		if (envToken) {
			cachedToken = envToken;
			updateWindowCache(cachedToken);
			if (import.meta.env.DEV) {
				console.log("[SessionToken] Loaded from environment");
			}
			return cachedToken;
		}

		if (import.meta.env.DEV) {
			console.warn("[SessionToken] No token available");
		}
		return null;
	})();

	try {
		const result = await tokenLoadPromise;
		return result;
	} finally {
		tokenLoadPromise = null;
	}
}

/**
 * Get session token synchronously (returns cached value only).
 * Use this when you need immediate access and async is not possible.
 *
 * @returns Cached session token or null
 */
export function getSessionTokenSync(): string | null {
	return cachedToken;
}

/**
 * Refresh session token by clearing cache and reloading.
 * Call this if token validation fails and you want to retry.
 *
 * @returns Promise resolving to new session token or null
 */
export async function refreshSessionToken(): Promise<string | null> {
	cachedToken = null;
	tokenLoadPromise = null;
	return getSessionToken();
}

/**
 * Set session token manually (for testing or direct injection).
 *
 * @param token - Token string to set
 */
export function setSessionToken(token: string | null): void {
	cachedToken = token;
}
