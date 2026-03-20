/**
 * useAsync - loading/error の手動管理を共通化するヘルパーフック
 *
 * useMcpServers / useMcpStore / useMcpPolicy / useMcpConfig など
 * 複数フックで繰り返し書かれていた try/catch/finally + setLoading/setError
 * パターンを一元化する。
 */

import { useCallback, useState } from "react";

// ---- ユーティリティ型 ----

/** 非同期操作の状態 */
export interface AsyncState {
    /** 処理中かどうか */
    loading: boolean;
    /** エラーメッセージ（null = エラーなし） */
    error: string | null;
}

/** run() の返り値 */
export interface UseAsyncResult extends AsyncState {
    /**
     * 非同期関数をラップし、loading/error を管理しながら実行する。
     * エラー時は error にセットしたうえで例外を再スローする。
     *
     * @param fn - 実行する非同期処理
     * @returns fn の返り値（失敗時は undefined）
     */
    run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
    /** エラーを手動でクリア */
    clearError: () => void;
}

// ---- フック本体 ----

/**
 * 非同期操作の loading / error 状態を管理するフック。
 *
 * @example
 * ```ts
 * const { loading, error, run } = useAsync();
 *
 * const handleSave = async () => {
 *   await run(async () => {
 *     await apiClient.post("api/mcp/config", config);
 *   });
 * };
 * ```
 */
export function useAsync(): UseAsyncResult {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
        setLoading(true);
        setError(null);
        try {
            const result = await fn();
            return result;
        } catch (err) {
            // 文字列またはError系からメッセージを抽出
            const message =
                err instanceof Error
                    ? err.message
                    : typeof err === "string"
                        ? err
                        : "Operation failed";
            setError(message);
            throw err;
        } finally {
            setLoading(false);
        }
    }, []);

    const clearError = useCallback(() => setError(null), []);

    return { loading, error, run, clearError };
}
