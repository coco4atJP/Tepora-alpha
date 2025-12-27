import React, { useEffect, useState, useCallback } from 'react';
import { getAuthHeaders } from '../utils/api';

const Logs: React.FC = () => {
    const [logs, setLogs] = useState<string[]>([]);
    const [selectedLog, setSelectedLog] = useState<string | null>(null);
    const [logContent, setLogContent] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [contentLoading, setContentLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchLogs = useCallback(async () => {
        try {
            const response = await fetch('/api/logs', {
                headers: { ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Failed to fetch logs');
            const data = await response.json();
            setLogs(data.logs);
            setLoading(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
            setLoading(false);
        }
    }, []);

    const fetchLogContent = useCallback(async (filename: string) => {
        setContentLoading(true);
        try {
            const response = await fetch(`/api/logs/${filename}`, {
                headers: { ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Failed to fetch log content');
            const data = await response.json();
            setLogContent(data.content);
            setContentLoading(false);
        } catch (err) {
            setLogContent(`Error loading log content: ${err instanceof Error ? err.message : 'Unknown error'}`);
            setContentLoading(false);
        }
    }, []);

    // 初回ロード
    useEffect(() => {
        fetchLogs();
    }, [fetchLogs]);

    // ログ一覧が更新され、かつ未選択の場合に最初のログを選択
    useEffect(() => {
        if (logs.length > 0 && !selectedLog) {
            setSelectedLog(logs[0]);
        }
    }, [logs, selectedLog]);

    useEffect(() => {
        if (selectedLog) {
            fetchLogContent(selectedLog);
        }
    }, [selectedLog, fetchLogContent]);

    if (loading) return <div className="p-8 text-white">Loading logs...</div>;

    return (
        <div className="flex h-full bg-gray-900">
            {/* Sidebar List */}
            <div className="w-64 border-r border-gray-800 bg-gray-900/50 flex flex-col">
                <div className="p-4 border-b border-gray-800">
                    <h2 className="text-xl font-bold text-white">Log Files</h2>
                    <button
                        onClick={fetchLogs}
                        className="mt-2 text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                    >
                        ↻ Refresh List
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {logs.map(log => (
                        <button
                            key={log}
                            onClick={() => setSelectedLog(log)}
                            className={`w-full text-left px-4 py-3 text-sm truncate transition-colors ${selectedLog === log
                                ? 'bg-blue-600/20 text-blue-400 border-r-2 border-blue-500'
                                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                                }`}
                        >
                            {log}
                        </button>
                    ))}
                    {logs.length === 0 && (
                        <div className="p-4 text-gray-500 text-sm text-center">No logs found</div>
                    )}
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col min-w-0">
                {error && (
                    <div className="bg-red-500/10 border-b border-red-500 text-red-500 p-2 text-sm text-center">
                        {error}
                    </div>
                )}
                <div className="p-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                    <h2 className="text-lg font-medium text-white truncate">
                        {selectedLog || 'Select a log'}
                    </h2>
                    {selectedLog && (
                        <button
                            onClick={() => fetchLogContent(selectedLog)}
                            className="text-sm text-gray-400 hover:text-white px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 transition-colors"
                        >
                            Refresh Content
                        </button>
                    )}
                </div>

                <div className="flex-1 p-4 overflow-hidden relative">
                    {contentLoading && (
                        <div className="absolute inset-0 bg-gray-900/50 flex items-center justify-center z-10 backdrop-blur-sm">
                            <div className="text-blue-400">Loading content...</div>
                        </div>
                    )}
                    <div className="h-full bg-black/30 rounded-lg border border-gray-800 p-4 overflow-auto font-mono text-xs text-gray-300 whitespace-pre-wrap">
                        {logContent || 'Select a log file to view its content.'}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Logs;
