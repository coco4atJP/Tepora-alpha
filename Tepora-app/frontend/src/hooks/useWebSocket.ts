import { useCallback } from 'react';
import { Message, WebSocketMessage, MemoryStats, ChatMode, SearchResult, Attachment, ActivityLogEntry } from '../types';
import { useChatState } from './chat/useChatState';
import { useSocketConnection } from './chat/useSocketConnection';
import { useMessageBuffer } from './chat/useMessageBuffer';

export const useWebSocket = () => {
  const {
    messages, setMessages,
    searchResults, setSearchResults,
    activityLog, setActivityLog,
    isProcessing, setIsProcessing,
    memoryStats, setMemoryStats,
    error, setError,
    clearMessages, clearError
  } = useChatState();

  const { handleChunk, flushAndClose } = useMessageBuffer(setMessages);

  const onMessage = useCallback((event: MessageEvent) => {
    try {
      const data: WebSocketMessage = JSON.parse(event.data);
      console.log('WS Received:', data);

      switch (data.type) {
        case 'chunk':
          handleChunk(data);
          break;

        case 'done':
          flushAndClose();
          setIsProcessing(false);
          break;

        case 'status':
          // Status messages doesn't affect visible state here
          break;

        case 'stopped':
          flushAndClose();
          setIsProcessing(false);
          break;

        case 'error': {
          const errorMessageStr = data.message || 'Unknown error';
          setError(errorMessageStr);

          const errorMessage: Message = {
            id: Date.now().toString(),
            role: 'system',
            content: `エラー: ${errorMessageStr} `,
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, errorMessage]);
          setIsProcessing(false);
          break;
        }

        case 'stats':
          if (data.data) {
            setMemoryStats(data.data as MemoryStats);
          }
          break;

        case 'search_results':
          if (data.data && Array.isArray(data.data)) {
            setSearchResults(data.data as SearchResult[]);
          }
          break;

        case 'activity':
          if (data.data) {
            const entry = data.data as ActivityLogEntry;
            setActivityLog((prev) => {
              const index = prev.findIndex((e) => e.id === entry.id);
              if (index !== -1) {
                const newLog = [...prev];
                newLog[index] = entry;
                return newLog;
              } else {
                return [...prev, entry];
              }
            });
          }
          break;
      }
    } catch (error) {
      console.error("WebSocket message parse error:", error);
      setError("Failed to parse server message");
    }
  }, [handleChunk, flushAndClose, setIsProcessing, setError, setMessages, setMemoryStats, setSearchResults, setActivityLog]);

  // Define callbacks before passing to useSocketConnection (React hooks best practice)
  const handleOpen = useCallback(() => {
    setIsProcessing(false);
    setError(null);
  }, [setIsProcessing, setError]);

  const handleError = useCallback((_error: Event) => {
    setError("Connection error");
  }, [setError]);

  const handleClose = useCallback(() => {
    setIsProcessing(false);
  }, [setIsProcessing]);

  const { isConnected, sendMessage: sendRaw } = useSocketConnection({
    onOpen: handleOpen,
    onMessage,
    onError: handleError,
    onClose: handleClose
  });

  const sendMessage = useCallback((content: string, mode: ChatMode = 'direct', attachments: Attachment[] = [], skipWebSearch: boolean = false) => {
    if (!isConnected) {
      setError("Not connected to server");
      return;
    }

    // Add user message locally
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
      mode,
    };
    setMessages((prev) => [...prev, userMessage]);
    setActivityLog([]); // Clear previous activity
    setError(null);

    // Send to server
    setIsProcessing(true);
    sendRaw(
      JSON.stringify({
        message: content,
        mode,
        attachments,
        skipWebSearch,
      })
    );
  }, [isConnected, setMessages, setActivityLog, setError, setIsProcessing, sendRaw]);

  const requestStats = useCallback(() => {
    if (!isConnected) {
      return;
    }
    sendRaw(JSON.stringify({ type: 'get_stats' }));
  }, [isConnected, sendRaw]);

  const stopGeneration = useCallback(() => {
    if (!isConnected) {
      return;
    }
    sendRaw(JSON.stringify({ type: 'stop' }));
    setIsProcessing(false);
  }, [isConnected, sendRaw, setIsProcessing]);

  return {
    messages,
    searchResults,
    activityLog,
    isConnected,
    isProcessing,
    memoryStats,
    error,
    sendMessage,
    clearMessages,
    requestStats,
    clearError,
    stopGeneration
  };
};



