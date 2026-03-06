// メッセージタイプ
export interface Message {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: Date;
	mode?: "chat" | "search" | "agent";
	agentName?: string;
	nodeId?: string;
	thinking?: string;
	isComplete?: boolean;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export type ApprovalDecision = "deny" | "once" | "always_until_expiry";
export type PermissionScopeKind = "native_tool" | "mcp_server";
export type PermissionRiskLevel = "low" | "medium" | "high" | "critical";

export interface PiiFinding {
	category: string;
	preview: string;
}

export interface PermissionEntry {
	scope_kind: PermissionScopeKind;
	scope_name: string;
	decision: ApprovalDecision;
	expires_at?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
}

export interface AuditVerifyResult {
	valid: boolean;
	entries: number;
	failure_at?: number | null;
	message?: string | null;
}

export interface CredentialStatus {
	provider: string;
	status: string;
	present: boolean;
	expires_at?: string | null;
	last_rotated_at?: string | null;
}

export interface BackupEnvelope {
	version: number;
	algorithm: string;
	nonce_hex: string;
	ciphertext_hex: string;
}

export interface BackupManifest {
	schema_version: number;
	exported_at: string;
	include_chat_history: boolean;
	include_settings: boolean;
	include_characters: boolean;
	include_executors: boolean;
}

export interface BackupExportPayload {
	filename: string;
	archive: BackupEnvelope;
	manifest: BackupManifest;
}

export interface BackupImportResult {
	stage: string;
	manifest: BackupManifest;
	sessions: number;
	applied: boolean;
}

export interface ToolConfirmationRequest {
	requestId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	description?: string;
	scope: PermissionScopeKind;
	scopeName: string;
	riskLevel: PermissionRiskLevel;
	expiryOptions: number[];
}

export interface ToolConfirmationResponse {
	decision: ApprovalDecision;
	ttlSeconds?: number;
}

export interface AgentActivity {
	status: "pending" | "processing" | "completed" | "error";
	agent_name: string;
	details: string;
	step: number;
}

export interface ActivityLogEntry {
	id: string;
	status: "pending" | "processing" | "done" | "error";
	message: string;
	agentName?: string;
}

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
	| "download_progress"
	| "interaction_complete"
	| "memory_generation"
	| "thought";
	message?: string;
	messages?: Message[];
	sessionId?: string;
	status?: "started" | "completed";
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

export type WebSocketOutgoingMessage =
	| {
			type?: undefined;
			message: string;
			mode: ChatMode;
			attachments?: Attachment[];
			skipWebSearch?: boolean;
			thinkingBudget?: number;
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
			decision: ApprovalDecision;
			ttlSeconds?: number;
			approved?: boolean;
		};

export interface SystemStatus {
	initialized: boolean;
	em_llm_enabled: boolean;
	total_messages: number;
	memory_events: number;
}

export interface MemorySystemStats {
	total_events: number;
	total_tokens_in_memory: number;
	mean_event_size: number;
	layer_counts?: {
		lml: number;
		sml: number;
	};
	mean_strength?: number;
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

export interface MemoryStats {
	char_memory?: MemorySystemStats;
	prof_memory?: MemorySystemStats;
}

export interface Session {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
	message_count?: number;
	preview?: string;
}

export type ChatMode = "chat" | "search" | "agent";
export type AgentMode = "high" | "fast" | "direct";

export interface Attachment {
	name: string;
	content: string;
	type: string;
	path?: string;
	url?: string;
	piiConfirmed?: boolean;
	piiFindings?: PiiFinding[];
}

export interface CharacterConfig {
	name: string;
	description: string;
	system_prompt: string;
	model_config_name?: string;
	icon?: string;
	avatar_path?: string;
}

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

export interface PersonaPreset {
	key: string;
	preview: string;
	name?: string;
}

export interface ModelInfo {
	id: string;
	display_name: string;
	role: string;
	file_size: number;
	filename?: string;
	file_path?: string;
	source: string;
	loader?: string;
	is_active?: boolean;
}
