/**
 * API設定ユーティリティ
 * 
 * 動的ポート取得をサポート。
 * デスクトップモードではsidecarからポートを受け取り、
 * Webモードではデフォルトまたは環境変数を使用。
 */

// Tauriアプリかどうかを判定
export const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

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
    return import.meta.env.VITE_API_PORT || '8000';
}

/**
 * Get authentication headers for API requests.
 * Currently returns empty headers as localhost auth is skipped,
 * but provides the structure for future remote access scenarios.
 */
export function getAuthHeaders(): Record<string, string> {
    // For localhost desktop app, auth is skipped by backend.
    // If remote access is enabled in the future, retrieve key from secure storage.
    const apiKey = import.meta.env.VITE_API_KEY || '';
    if (apiKey) {
        return { 'x-api-key': apiKey };
    }
    return {};
}

/**
 * API のベース URL
 * - デスクトップ (Tauri) の場合: http://localhost:{port}
 * - Web の場合: '' (相対パス、Vite のプロキシを使用)
 */
export function getApiBase(): string {
    if (isDesktop) {
        return `http://localhost:${getApiPort()}`;
    }
    return '';
}

/**
 * WebSocket のベース URL
 * - デスクトップ (Tauri) の場合: ws://localhost:{port}
 * - Web の場合: '' (相対パス、Vite のプロキシを使用)
 */
export function getWsBase(): string {
    if (isDesktop) {
        return `ws://localhost:${getApiPort()}`;
    }
    return '';
}

// 後方互換性のための静的エクスポート（初期値）
// 注意: 動的ポート取得後は getApiBase()/getWsBase() を使用すること
const apiPort = import.meta.env.VITE_API_PORT || '8000';
export const API_BASE = isDesktop ? `http://localhost:${apiPort}` : '';
export const WS_BASE = isDesktop ? `ws://localhost:${apiPort}` : '';
