import { useEffect, useRef, useState } from 'react';
import { Message, WebSocketMessage, MemoryStats } from '../types';

const WS_URL = 'ws://localhost:8000/ws/chat';

export const useWebSocket = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  const connect = () => {
    try {
      const ws = new WebSocket(WS_URL);
      
      ws.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
        setIsProcessing(false);
      };

      ws.onmessage = (event) => {
        try {
          const data: WebSocketMessage = JSON.parse(event.data);
          
          switch (data.type) {
            case 'response':
              if (data.message) {
                const newMessage: Message = {
                  id: Date.now().toString(),
                  role: 'assistant',
                  content: data.message,
                  timestamp: new Date(),
                  mode: data.mode as any,
                };
                setMessages((prev) => [...prev, newMessage]);
              }
              setIsProcessing(false);
              break;

            case 'status':
              // ステータスメッセージは表示しない（処理中フラグのみ）
              console.log('Status:', data.message);
              break;

            case 'error':
              const errorMessage: Message = {
                id: Date.now().toString(),
                role: 'system',
                content: `エラー: ${data.message}`,
                timestamp: new Date(),
              };
              setMessages((prev) => [...prev, errorMessage]);
              setIsProcessing(false);
              break;

            case 'stats':
              if (data.data) {
                setMemoryStats(data.data as MemoryStats);
              }
              break;
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);
        setIsProcessing(false);
        
        // 自動再接続（5秒後）
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('Attempting to reconnect...');
          connect();
        }, 5000);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      setIsConnected(false);
    }
  };

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const sendMessage = (content: string, mode: 'direct' | 'search' | 'agent' = 'direct') => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('WebSocket is not connected');
      return;
    }

    // ユーザーメッセージを追加
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
      mode,
    };
    setMessages((prev) => [...prev, userMessage]);

    // サーバーに送信
    setIsProcessing(true);
    wsRef.current.send(
      JSON.stringify({
        message: content,
        mode,
      })
    );
  };

  const clearMessages = () => {
    setMessages([]);
  };

  return {
    messages,
    isConnected,
    isProcessing,
    memoryStats,
    sendMessage,
    clearMessages,
  };
};
