import React, { useEffect, useRef } from 'react';
import { Message } from '../types';
import { Bot, User, AlertCircle } from 'lucide-react';

interface MessageListProps {
  messages: Message[];
}

const MessageList: React.FC<MessageListProps> = ({ messages }) => {
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatContent = (content: string) => {
    // 簡易的なマークダウン変換
    return content
      .split('\n')
      .map((line, i) => {
        // コードブロック
        if (line.startsWith('```')) {
          return null; // 複数行コードブロックは別途処理が必要
        }
        // 箇条書き
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return <li key={i} className="ml-4">{line.slice(2)}</li>;
        }
        // 見出し
        if (line.startsWith('# ')) {
          return <h1 key={i} className="text-2xl font-bold my-2">{line.slice(2)}</h1>;
        }
        if (line.startsWith('## ')) {
          return <h2 key={i} className="text-xl font-bold my-2">{line.slice(3)}</h2>;
        }
        if (line.startsWith('### ')) {
          return <h3 key={i} className="text-lg font-bold my-2">{line.slice(4)}</h3>;
        }
        // 通常の段落
        return line ? <p key={i} className="my-1">{line}</p> : <br key={i} />;
      });
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-gray-500">
          <Bot className="w-16 h-16 mb-4" />
          <p className="text-lg">メッセージを送信して会話を開始しましょう</p>
          <p className="text-sm mt-2">モードを選択してください：</p>
          <ul className="text-sm mt-1 space-y-1">
            <li>• <strong>ダイレクト</strong>: 直接応答</li>
            <li>• <strong>検索</strong>: Web検索を使用</li>
            <li>• <strong>エージェント</strong>: ツールを使用した高度な処理</li>
          </ul>
        </div>
      )}

      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
        >
          <div
            className={`flex max-w-[80%] ${
              message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
            } gap-3`}
          >
            {/* アイコン */}
            <div
              className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                message.role === 'user'
                  ? 'bg-primary-600'
                  : message.role === 'system'
                  ? 'bg-yellow-600'
                  : 'bg-gray-700'
              }`}
            >
              {message.role === 'user' ? (
                <User className="w-5 h-5" />
              ) : message.role === 'system' ? (
                <AlertCircle className="w-5 h-5" />
              ) : (
                <Bot className="w-5 h-5" />
              )}
            </div>

            {/* メッセージ本体 */}
            <div
              className={`rounded-lg p-4 ${
                message.role === 'user'
                  ? 'bg-primary-600 text-white'
                  : message.role === 'system'
                  ? 'bg-yellow-900/50 text-yellow-200 border border-yellow-700'
                  : 'bg-gray-800 text-gray-100 border border-gray-700'
              }`}
            >
              {message.mode && message.role === 'user' && (
                <div className="text-xs opacity-70 mb-1">
                  {message.mode === 'search' && '🔍 検索モード'}
                  {message.mode === 'agent' && '🤖 エージェントモード'}
                  {message.mode === 'direct' && '💬 ダイレクトモード'}
                </div>
              )}
              <div className="markdown-content whitespace-pre-wrap break-words">
                {formatContent(message.content)}
              </div>
              <div className="text-xs opacity-50 mt-2">
                {message.timestamp.toLocaleTimeString('ja-JP')}
              </div>
            </div>
          </div>
        </div>
      ))}

      <div ref={endOfMessagesRef} />
    </div>
  );
};

export default MessageList;
