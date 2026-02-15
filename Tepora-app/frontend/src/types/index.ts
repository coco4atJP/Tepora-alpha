// メッセージタイプ
export interface Message {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: Date;
	mode?: "chat" | "search" | "agent";
	agentName?: string;
	nodeId?: string;
	thinking?: string; // Chain of Thought content
	isComplete?: boolean; // ストリーミングメッセージの完了フラグ
}

export interface SearchResult {
	title: string;
	url: string; // Changed from link to url to match usage
	snippet: string;
}

// WebSocketメッセージタイプ
export interface AgentActivity {
	status: "pending" | "processing" | "completed" | "error";
	agent_name: string;
	details: string;
	step: number;
}

// Backend format (received via WebSocket)
export interface ActivityLogEntry {
	id: string;
	status: "pending" | "processing" | "done" | "error";
	message: string;
	agentName?: string;
}

// Tool Confirmation Request (from backend)
export interface ToolConfirmationRequest {
	requestId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	description?: string;
}

// ============================================================================
// WebSocket Message Types
// ============================================================================

// Incoming message types (from server)
export interface WebSocketMessage {
	type:
		| "chunk"
		| "done"
		| "status"
		| "error"
		| "stats"
		| "search_results"
		| "activity"
		| "stopped"
		| "tool_confirmation_request"
		| "history"
		| "session_changed"
		| "download_progress";
	message?: string;
	messages?: Message[]; // For history loading
	sessionId?: string; // For session_changed event
	mode?: string;
	agentName?: string;
	nodeId?: string;
	data?:
		| MemoryStats
		| Record<string, unknown>
		| SearchResult[]
		| AgentActivity[]
		| ToolConfirmationRequest;
}

// Outgoing message types (to server)
export type WebSocketOutgoingMessage =
	| {
			type?: undefined;
			message: string;
			mode: ChatMode;
			attachments?: Attachment[];
			skipWebSearch?: boolean;
			thinkingMode?: boolean; // Toggle Chain of Thought
			sessionId?: string;
			agentId?: string;
			agentMode?: AgentMode;
	  }
	| { type: "stop" }
	| { type: "get_stats" }
	| { type: "set_session"; sessionId: string }
	| {
			type: "tool_confirmation_response";
			requestId: string;
			approved: boolean;
	  };

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

// ============================================================================
// Session Types
// ============================================================================

export interface Session {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
	message_count?: number;
	preview?: string;
}

// チャットモード
export type ChatMode = "chat" | "search" | "agent";
export type AgentMode = "high" | "fast" | "direct";

// 添付ファイル
export interface Attachment {
	name: string;
	content: string; // Base64 encoded content or text
	type: string; // MIME type
	path?: string; // Optional file path (for local files if applicable)
}

// Configuration Types (Matches Backend Schema)
export interface CharacterConfig {
	name: string;
	description: string;
	system_prompt: string;
	model_config_name?: string;
	icon?: string;
	avatar_path?: string;
}

// Custom Agent Types (GPTs/Gems-style)
export interface CustomAgentToolPolicy {
	allow_all?: boolean;
	allowed_tools: string[];
	denied_tools: string[];
	require_confirmation: string[];
}

export interface CustomAgentConfig {
	id: string;
	name: string;
	description: string;
	icon?: string;
	system_prompt: string;
	tool_policy: CustomAgentToolPolicy;
	model_config_name?: string;
	tags: string[];
	priority: number;
	enabled: boolean;
}

export interface ToolInfo {
	name: string;
	description: string;
}

// Deprecated/Legacy types (Transitioning)
export interface PersonaPreset {
	key: string;
	preview: string;
	name?: string;
}
