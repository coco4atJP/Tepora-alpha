import React, { createContext, useContext, ReactNode } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { ChatMode, Attachment, Message, SearchResult, MemoryStats, AgentActivity, ToolConfirmationRequest } from '../types';

interface WebSocketContextType {
    isConnected: boolean;
    isProcessing: boolean;
    messages: Message[];
    searchResults: SearchResult[];
    memoryStats: MemoryStats | null;
    activityLog: AgentActivity[];
    sendMessage: (content: string, mode: ChatMode, attachments?: Attachment[], skipWebSearch?: boolean) => void;
    clearMessages: () => void;
    stopGeneration: () => void;
    error: string | null;
    clearError: () => void;
    // Tool confirmation (A+C Hybrid)
    pendingToolConfirmation: ToolConfirmationRequest | null;
    handleToolConfirmation: (requestId: string, approved: boolean, remember: boolean) => void;
    // Session management
    currentSessionId: string;
    setCurrentSessionId: (sessionId: string) => void;
}

const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined);

export const WebSocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const wsData = useWebSocket();

    return (
        <WebSocketContext.Provider value={wsData}>
            {children}
        </WebSocketContext.Provider>
    );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useWebSocketContext = () => {
    const context = useContext(WebSocketContext);
    if (!context) {
        throw new Error('useWebSocketContext must be used within a WebSocketProvider');
    }
    return context;
};
