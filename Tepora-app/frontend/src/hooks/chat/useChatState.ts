import { useState, useCallback } from 'react';
import { Message, SearchResult, ActivityLogEntry, MemoryStats } from '../../types';

export const useChatState = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
    const [error, setError] = useState<string | null>(null);

    const clearMessages = useCallback(() => {
        setMessages([]);
        setSearchResults([]);
        setActivityLog([]);
        setError(null);
    }, []);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    return {
        messages,
        setMessages,
        searchResults,
        setSearchResults,
        activityLog,
        setActivityLog,
        isProcessing,
        setIsProcessing,
        memoryStats,
        setMemoryStats,
        error,
        setError,
        clearMessages,
        clearError
    };
};
