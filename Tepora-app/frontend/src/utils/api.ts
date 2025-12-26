/**
 * API設定ユーティリティ
 * 
 * 環境変数 VITE_API_PORT を使用してAPIポートを設定可能にします。
 * デフォルトは8000です。
 */

// Tauriアプリかどうかを判定
export const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

// 環境変数からポートを取得（デフォルト: 8000）
const apiPort = import.meta.env.VITE_API_PORT || '8000';

/**
 * API のベース URL
 * - デスクトップ (Tauri) の場合: http://localhost:{port}
 * - Web の場合: '' (相対パス、Vite のプロキシを使用)
 */
export const API_BASE = isDesktop ? `http://localhost:${apiPort}` : '';

/**
 * WebSocket のベース URL
 * - デスクトップ (Tauri) の場合: ws://localhost:{port}
 * - Web の場合: '' (相対パス、Vite のプロキシを使用)
 */
export const WS_BASE = isDesktop ? `ws://localhost:${apiPort}` : '';
