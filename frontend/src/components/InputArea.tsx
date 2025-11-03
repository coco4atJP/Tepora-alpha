import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { ChatMode } from '../types';

interface InputAreaProps {
  onSendMessage: (message: string, mode: ChatMode) => void;
  isProcessing: boolean;
  isConnected: boolean;
}

const InputArea: React.FC<InputAreaProps> = ({ onSendMessage, isProcessing, isConnected }) => {
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<ChatMode>('direct');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [message]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!message.trim() || isProcessing || !isConnected) {
      return;
    }

    onSendMessage(message.trim(), mode);
    setMessage('');
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="border-t border-gray-700 bg-gray-900 p-4">
      {/* モード選択 */}
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => setMode('direct')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === 'direct'
              ? 'bg-primary-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          💬 ダイレクト
        </button>
        <button
          type="button"
          onClick={() => setMode('search')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === 'search'
              ? 'bg-primary-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          🔍 検索
        </button>
        <button
          type="button"
          onClick={() => setMode('agent')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === 'agent'
              ? 'bg-primary-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          🤖 エージェント
        </button>
      </div>

      {/* 入力フォーム */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !isConnected
              ? '接続中...'
              : mode === 'direct'
              ? 'メッセージを入力... (Shift+Enterで改行)'
              : mode === 'search'
              ? '検索クエリを入力...'
              : 'タスクを入力...'
          }
          disabled={isProcessing || !isConnected}
          className="flex-1 input-primary resize-none min-h-[44px] max-h-[200px]"
          rows={1}
        />
        <button
          type="submit"
          disabled={!message.trim() || isProcessing || !isConnected}
          className="btn-primary px-6 flex items-center gap-2"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              処理中
            </>
          ) : (
            <>
              <Send className="w-4 h-4" />
              送信
            </>
          )}
        </button>
      </form>

      {/* ヘルプテキスト */}
      <div className="mt-2 text-xs text-gray-500">
        {mode === 'direct' && 'キャラクターエージェント (Gemma 3N) が直接応答します'}
        {mode === 'search' && 'Google検索を使用して最新情報を取得します'}
        {mode === 'agent' && 'プロフェッショナルエージェント (Jan-nano) がツールを使用してタスクを実行します'}
      </div>
    </div>
  );
};

export default InputArea;
