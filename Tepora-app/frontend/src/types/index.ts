// メッセージタイプ
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  mode?: 'direct' | 'search' | 'agent';
  agentName?: string;
  nodeId?: string;
  isComplete?: boolean; // ストリーミングメッセージの完了フラグ
}

export interface SearchResult {
  title: string;
  url: string; // Changed from link to url to match usage
  snippet: string;
}

// WebSocketメッセージタイプ
export interface AgentActivity {
  status: 'pending' | 'processing' | 'completed' | 'error';
  agent_name: string;
  details: string;
  step: number;
}

export interface ActivityLogEntry {
  id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  message: string;
}

export interface WebSocketMessage {
  type: 'chunk' | 'done' | 'status' | 'error' | 'stats' | 'search_results' | 'activity' | 'stopped';
  message?: string;
  mode?: string;
  agentName?: string;
  nodeId?: string;
  data?: MemoryStats | Record<string, unknown> | SearchResult[] | AgentActivity[];
}

// システムステータス
export interface SystemStatus {
  initialized: boolean;
  em_llm_enabled: boolean;
  total_messages: number;
  memory_events: number;
}

// メモリ統計
// バックエンドの EM-LLM integrator が返す実際の構造に合わせた型定義
export interface MemorySystemStats {
  total_events: number;
  total_tokens_in_memory: number;
  mean_event_size: number;
  surprise_statistics?: {
    mean: number;
    std: number;
    max: number;
  };
  configuration?: {
    surprise_gamma: number;
    min_event_size: number;
    max_event_size: number;
    total_retrieved_events: number;
  };
  llm_config?: Record<string, unknown>;
}

// メモリ統計全体
export interface MemoryStats {
  char_memory?: MemorySystemStats;
  prof_memory?: MemorySystemStats;
}

// チャットモード
export type ChatMode = 'direct' | 'search' | 'agent';

// 添付ファイル
export interface Attachment {
  name: string;
  content: string; // Base64 encoded content or text
  type: string; // MIME type
  path?: string; // Optional file path (for local files if applicable)
}
