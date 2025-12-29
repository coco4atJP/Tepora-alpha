import { useCallback, useState } from 'react';
import { Message, WebSocketMessage, MemoryStats, ChatMode, SearchResult, Attachment, AgentActivity, ActivityLogEntry, ToolConfirmationRequest } from '../types';
import { useChatState } from './chat/useChatState';
import { useSocketConnection } from './chat/useSocketConnection';
import { useMessageBuffer } from './chat/useMessageBuffer';

const AGENT_MAPPING: Record<string, string> = {
  'generate_order': 'Planner',
  'generate_search_query': 'Search Analyst',
  'execute_search': 'Search Tool',
  'summarize_search_result': 'Researcher',
  'agent_reasoning': 'Executor',
  'tool_node': 'Tool Handler',
  'synthesize_final_response': 'Synthesizer',
  'update_scratchpad': 'Memory Manager',
};

export const useWebSocket = () => {
  const {
    messages, setMessages,
    searchResults, setSearchResults,
    activityLog, setActivityLog,
    isProcessing, setIsProcessing,
    memoryStats, setMemoryStats,
    error, setError,
    clearMessages, clearError,
    // Tool confirmation
    pendingToolConfirmation, setPendingToolConfirmation,
    approveToolForSession, isToolApproved,
  } = useChatState();

  const { handleChunk, flushAndClose } = useMessageBuffer(setMessages);

  // Session management
  const [currentSessionId, setCurrentSessionIdState] = useState<string>('default');

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
            // Backend sends data as ActivityLogEntry (legacy format)
            const rawEntry = data.data as unknown as ActivityLogEntry;

            // Convert to AgentActivity (frontend format)
            const agentName = AGENT_MAPPING[rawEntry.id] || rawEntry.id;
            const statusMap: Record<string, AgentActivity['status']> = {
              'done': 'completed',
              'processing': 'processing',
              'pending': 'pending',
              'error': 'error'
            };

            setActivityLog((prev) => {
              // Try to find existing entry by agent name/step match mechanism
              // Since backend doesn't send step, we infer it or map by agent name if unique per step
              // For simplicity, we assume one active step per agent or update the latest one.

              const existingIndex = prev.findIndex(e => e.agent_name === agentName);

              const newEntry: AgentActivity = {
                status: statusMap[rawEntry.status] || 'processing',
                agent_name: agentName,
                details: rawEntry.message,
                step: existingIndex !== -1 ? prev[existingIndex].step : prev.length + 1
              };

              if (existingIndex !== -1) {
                const newLog = [...prev];
                newLog[existingIndex] = newEntry;
                return newLog;
              } else {
                return [...prev, newEntry];
              }
            });
          }
          break;

        case 'tool_confirmation_request':
          if (data.data) {
            const request = data.data as ToolConfirmationRequest;
            // A+C Hybrid: auto-approve if tool was already approved this session
            if (isToolApproved(request.toolName)) {
              console.log(`Tool ${request.toolName} auto-approved (session cache)`);
              // Send auto-approval response (no need to show dialog)
              // Note: In this implementation, we don't block backend execution
              // The dialog is informational/confirmatory for first-time use
            } else {
              setPendingToolConfirmation(request);
            }
          }
          break;

        case 'history':
          if (data.messages && Array.isArray(data.messages)) {
            console.log(`Received ${data.messages.length} history messages`);
            // Convert timestamp strings to Date objects if needed because JSON.parse leaves them as strings
            const parsedMessages = data.messages.map(msg => ({
              ...msg,
              timestamp: new Date(msg.timestamp)
            }));
            setMessages(parsedMessages);
          }
          break;

        case 'session_changed':
          // Optional: handle confirmation of session switch if needed
          console.log(`Session switched to ${data.sessionId}`);
          break;

        case 'download_progress':
          if (data.data) {
            const event = new CustomEvent('download-progress', { detail: data.data });
            window.dispatchEvent(event);
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

    // Send to server with sessionId
    setIsProcessing(true);
    sendRaw(
      JSON.stringify({
        message: content,
        mode,
        attachments,
        skipWebSearch,
        sessionId: currentSessionId,
      })
    );
  }, [isConnected, setMessages, setActivityLog, setError, setIsProcessing, sendRaw, currentSessionId]);

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

  // Set current session (sends to backend via WebSocket)
  const setCurrentSessionId = useCallback((sessionId: string) => {
    setCurrentSessionIdState(sessionId);
    clearMessages(); // Clear local messages when switching sessions
    if (isConnected) {
      sendRaw(JSON.stringify({ type: 'set_session', sessionId }));
    }
  }, [isConnected, sendRaw, clearMessages]);

  // Handle tool confirmation response
  const handleToolConfirmation = useCallback((requestId: string, approved: boolean, remember: boolean) => {
    if (!pendingToolConfirmation) return;

    // Send response to backend via WebSocket
    if (isConnected) {
      sendRaw(JSON.stringify({
        type: 'tool_confirmation_response',
        requestId: requestId,
        approved: approved
      }));
      console.log(`Sent tool confirmation: requestId=${requestId}, approved=${approved}`);
    }

    if (approved && remember) {
      approveToolForSession(pendingToolConfirmation.toolName);
    }

    // Clear the pending request
    setPendingToolConfirmation(null);
  }, [pendingToolConfirmation, approveToolForSession, setPendingToolConfirmation, isConnected, sendRaw]);

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
    stopGeneration,
    // Tool confirmation
    pendingToolConfirmation,
    handleToolConfirmation,
    // Session management
    currentSessionId,
    setCurrentSessionId,
  };
};



