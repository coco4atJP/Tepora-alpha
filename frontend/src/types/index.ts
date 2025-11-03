// メッセージタイプ
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  mode?: 'direct' | 'search' | 'agent';
}

// WebSocketメッセージタイプ
export interface WebSocketMessage {
  type: 'response' | 'status' | 'error' | 'stats';
  message?: string;
  mode?: string;
  data?: Record<string, unknown>;
}

// システムステータス
export interface SystemStatus {
  initialized: boolean;
  em_llm_enabled: boolean;
  total_messages: number;
  memory_events: number;
}

// メモリ統計
export interface MemoryStats {
  total_events: number;
  total_tokens: number;
  mean_event_size: number;
}

// チャットモード
export type ChatMode = 'direct' | 'search' | 'agent';
