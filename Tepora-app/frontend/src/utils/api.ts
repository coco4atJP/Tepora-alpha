/**
 * API設定ユーティリティ
 *
 * 動的ポート取得をサポート。
 * デスクトップモードではsidecarからポートを受け取り、
 * Webモードではデフォルトまたは環境変数を使用。
 */

import { getSessionTokenSync } from "./sessionToken";

// Tauriアプリかどうかを判定
export function isDesktop(): boolean {
	return (
		typeof window !== "undefined" &&
		!!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
	);
}

// 動的ポート格納用（sidecarから設定される）
let dynamicPort: number | null = null;

/**
 * sidecarから取得したポートを設定
 */
export function setDynamicPort(port: number): void {
	dynamicPort = port;
	console.log(`[API] Dynamic port set to: ${port}`);
}

/**
 * 現在のAPIポートを取得
 */
export function getApiPort(): string {
	if (dynamicPort !== null) {
		return String(dynamicPort);
	}
	return import.meta.env.VITE_API_PORT || "8000";
}

/**
 * Get authentication headers for API requests (synchronous version).
 * Uses cached token if available, otherwise returns empty headers.
 * For guaranteed token availability, use getAuthHeadersAsync().
 */
export function getAuthHeaders(): Record<string, string> {
	// Read token from module-scoped cache (no window global)
	const cachedToken = getSessionTokenSync();
	if (cachedToken) {
		return { "x-api-key": cachedToken };
	}
	// Env fallback is only allowed in dev mode to prevent
	// token exposure via VITE_API_KEY in production builds
	if (import.meta.env.DEV) {
		const apiKey = import.meta.env.VITE_API_KEY || "";
		if (apiKey) {
			return { "x-api-key": apiKey };
		}
	}
	return {};
}

/**
 * Get authentication headers for API requests (async version).
 * Ensures token is loaded before returning headers.
 */
export async function getAuthHeadersAsync(): Promise<Record<string, string>> {
	const { getSessionToken } = await import("./sessionToken");
	const token = await getSessionToken();
	if (token) {
		return { "x-api-key": token };
	}
	return {};
}

/**
 * API のベース URL
 * - デスクトップ (Tauri) の場合: http://localhost:{port}
 * - Web の場合: '' (相対パス、Vite のプロキシを使用)
 */
export function getApiBase(): string {
	if (isDesktop()) {
		return `http://127.0.0.1:${getApiPort()}`;
	}
	return "";
}

/**
 * WebSocket のベース URL
 * - デスクトップ (Tauri) の場合: ws://localhost:{port}
 * - Web の場合: '' (相対パス、Vite のプロキシを使用)
 */
export function getWsBase(): string {
	if (isDesktop()) {
		return `ws://127.0.0.1:${getApiPort()}`;
	}
	return "";
}

// Deprecated static constants - maintained for localized refactoring but
// heavily discouraged. Use getApiBase() and getWsBase() instead.
// These will still be incorrect until port is dynamic, but we can make them getters property-wise if we wanted,
// but for now, we just removed the export of the const assignment that would be stale.
// Actually, to prevent compilation errors in other files before we fix them, we can keep them
// as getters using Object.defineProperty or just export functions.
// But better to just remove them and fix the errors.

// Re-export as property getters if you need compatibility, but here we will just redirect.
// NOTE: We are removing API_BASE and WS_BASE constants to force usage of functions.
// If this breaks build, we will fix the call sites.
