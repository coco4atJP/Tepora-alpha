import React from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import MessageList from './MessageList';
import InputArea from './InputArea';
import StatusBar from './StatusBar';
import { Trash2 } from 'lucide-react';

const ChatInterface: React.FC = () => {
  const {
    messages,
    isConnected,
    isProcessing,
    memoryStats,
    sendMessage,
    clearMessages,
  } = useWebSocket();

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      {/* ヘッダー */}
      <div className="bg-gray-900 border-b border-gray-700 p-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tepora AI Agent</h1>
          <p className="text-sm text-gray-400">EM-LLM搭載マルチエージェントシステム</p>
        </div>
        <button
          onClick={clearMessages}
          className="btn-secondary flex items-center gap-2"
          title="チャット履歴をクリア"
        >
          <Trash2 className="w-4 h-4" />
          クリア
        </button>
      </div>

      {/* ステータスバー */}
      <StatusBar isConnected={isConnected} memoryStats={memoryStats} />

      {/* メッセージリスト */}
      <MessageList messages={messages} />

      {/* 入力エリア */}
      <InputArea
        onSendMessage={sendMessage}
        isProcessing={isProcessing}
        isConnected={isConnected}
      />
    </div>
  );
};

export default ChatInterface;
