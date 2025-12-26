import React from 'react';
import { useOutletContext } from 'react-router-dom';
import { useWebSocketContext } from '../context/WebSocketContext';
import MessageList from './MessageList';
import InputArea from './InputArea';
import { Trash2 } from 'lucide-react';
import { ChatMode } from '../types';
import { useTranslation } from 'react-i18next';

interface ChatInterfaceContext {
  currentMode: ChatMode;
}

const ChatInterface: React.FC = () => {
  const { currentMode } = useOutletContext<ChatInterfaceContext>();
  const { t } = useTranslation();

  const {
    messages,
    isConnected,
    isProcessing,
    sendMessage,
    clearMessages,
    error,
    clearError,
    stopGeneration
  } = useWebSocketContext();

  return (
    <div className="flex flex-col h-full w-full relative">
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

      {/* Clear Button - Floating Top Left */}
      <div className="absolute top-4 left-4 z-20">
        <button
          onClick={clearMessages}
          className="glass-button p-2 text-coffee-200 hover:text-gold-300 flex items-center gap-2 text-xs"
          title={t('chat.clear_history')}
        >
          <Trash2 className="w-4 h-4" />
          <span className="hidden sm:inline">{t('common.clear')}</span>
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

