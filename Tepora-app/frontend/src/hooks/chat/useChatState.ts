import { useState, useCallback } from 'react';
import { Message, SearchResult, AgentActivity, MemoryStats, ToolConfirmationRequest } from '../../types';

export const useChatState = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [activityLog, setActivityLog] = useState<AgentActivity[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Tool confirmation state (A+C Hybrid)
    const [pendingToolConfirmation, setPendingToolConfirmation] = useState<ToolConfirmationRequest | null>(null);
    const [approvedTools, setApprovedTools] = useState<Set<string>>(new Set());

    const clearMessages = useCallback(() => {
        setMessages([]);
        setSearchResults([]);
        setActivityLog([]);
        setError(null);
    }, []);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    const approveToolForSession = useCallback((toolName: string) => {
        setApprovedTools((prev) => new Set(prev).add(toolName));
    }, []);

    const isToolApproved = useCallback((toolName: string) => {
        return approvedTools.has(toolName);
    }, [approvedTools]);

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
        clearError,
        // Tool confirmation
        pendingToolConfirmation,
        setPendingToolConfirmation,
        approvedTools,
        approveToolForSession,
        isToolApproved,
    };
};

