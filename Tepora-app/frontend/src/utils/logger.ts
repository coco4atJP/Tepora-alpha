/**
 * 構造化ロガーユーティリティ
 *
 * - `log` / `debug` は開発時のみ出力（`import.meta.env.DEV === true`）
 * - `warn` / `error` は常時出力（本番でも必要なシグナルのみ残す）
 *
 * 使用方法:
 *   import { logger } from "@/utils/logger";
 *   logger.log("[Sidecar] Starting backend...");  // 開発時のみ
 *   logger.error("[API] Request failed:", err);    // 常時
 */

import { getSessionTokenSync } from "./sessionToken";

const isDev = import.meta.env.DEV;

let isFrontendLoggingEnabled = false;
let isSending = false;
const FORWARDED_LEVELS = new Set(["warn", "error"]);

export const configureLogger = (enabled: boolean) => {
    isFrontendLoggingEnabled = enabled;
};

const sendToBackend = (level: string, ...args: unknown[]) => {
    if (!isFrontendLoggingEnabled || isSending || !FORWARDED_LEVELS.has(level)) return;
    isSending = true;
    try {
        const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ");
        const apiKey = getSessionTokenSync();
        // Fire and forget
        fetch("/api/logs/frontend", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "x-api-key": apiKey } : {})
            },
            body: JSON.stringify({ level, message })
        }).catch(() => { });
    } finally {
        isSending = false;
    }
};

export const logger = {
    /**
     * 開発時のみ出力する情報ログ。
     * 本番ビルドでは何もしない。
     */
    log: (...args: unknown[]): void => {
        if (isDev) {
            console.log(...args);
        }
        sendToBackend("info", ...args);
    },

    /**
     * 開発時のみ出力するデバッグログ。
     * 本番ビルドでは何もしない。
     */
    debug: (...args: unknown[]): void => {
        if (isDev) {
            console.debug(...args);
        }
        sendToBackend("debug", ...args);
    },

    /**
     * 警告ログ。開発・本番両方で出力する。
     * 運用上のシグナルとして必要な警告のみに使用すること。
     */
    warn: (...args: unknown[]): void => {
        console.warn(...args);
        sendToBackend("warn", ...args);
    },

    /**
     * エラーログ。開発・本番両方で出力する。
     * ユーザーに影響するエラー・回復不能な失敗に使用すること。
     */
    error: (...args: unknown[]): void => {
        console.error(...args);
        sendToBackend("error", ...args);
    },
} as const;
