import React from 'react';
import { useOutletContext } from 'react-router-dom';
import { useWebSocketContext } from '../context/WebSocketContext';
import MessageList from './MessageList';
import InputArea from './InputArea';
import ToolConfirmationDialog from './chat/ToolConfirmationDialog';
import { Plus } from 'lucide-react';
import { ChatMode } from '../types';
import { useTranslation } from 'react-i18next';
import { useSessions } from '../hooks/useSessions';

interface ChatInterfaceContext {
  currentMode: ChatMode;
}

const ChatInterface: React.FC = () => {
  const { currentMode } = useOutletContext<ChatInterfaceContext>();
  const { t } = useTranslation();
  const { createSession } = useSessions();
  const {
    messages,
    isConnected,
    isProcessing,
    sendMessage,
    error,
    clearError,
    stopGeneration,
    pendingToolConfirmation,
    handleToolConfirmation,
  } = useWebSocketContext();

  const handleCreateSession = () => {
    createSession();
  };

  return (
    <div className="flex flex-col h-full w-full relative">
      {/* Tool Confirmation Dialog */}
      <ToolConfirmationDialog
        request={pendingToolConfirmation}
        onAllow={(requestId, remember) => handleToolConfirmation(requestId, true, remember)}
        onDeny={(requestId) => handleToolConfirmation(requestId, false, false)}
      />

      {/* Error Toast */}
      {error && (
        <div className="absolute top-4 right-4 z-50 bg-red-500/90 text-white px-4 py-2 rounded shadow-lg backdrop-blur-sm flex items-center gap-2 animate-fade-in">
          <span>{error}</span>
          <button
            onClick={clearError}
            className="hover:bg-white/20 rounded-full p-1"
          >
            ×
          </button>
        </div>
      )}

      {/* New Session Button - Floating Top Left */}
      <div className="absolute top-4 left-4 z-20">
        <button
          onClick={handleCreateSession}
          className="glass-button p-2 text-coffee-200 hover:text-gold-300 flex items-center gap-2 text-xs"
          title={t('newSession', 'New Session')}
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {/* Message List - Scrollable Area */}
      <div className="flex-1 overflow-hidden relative min-h-0">
        <MessageList messages={messages} />
      </div>

      {/* Input Area - Fixed at Bottom */}
      <div className="p-4 md:p-6 w-full shrink-0">
        <InputArea
          onSendMessage={sendMessage}
          isProcessing={isProcessing}
          isConnected={isConnected}
          currentMode={currentMode}
          onStop={stopGeneration}
        />
      </div>
    </div>
  );
};

export default ChatInterface;
