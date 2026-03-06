/**
 * Centralized API Endpoints
 */

export const ENDPOINTS = {
	HEALTH: "health",
	SHUTDOWN: "api/shutdown",
	SESSIONS: {
		LIST: "api/sessions",
		DETAIL: (id: string) => `api/sessions/${id}`,
		METRICS: (id: string) => `api/sessions/${id}/metrics`,
	},
	METRICS: {
		RUNTIME: "api/metrics/runtime",
	},
	LOADERS: {
		OLLAMA: {
			REFRESH: "api/setup/models/ollama/refresh",
		},
		LMSTUDIO: {
			REFRESH: "api/setup/models/lmstudio/refresh",
		},
	},
	SETUP: {
		MODELS: "api/setup/models",
		MODEL_ROLES: "api/setup/model/roles",
		MODEL_ROLES_CHARACTER: "api/setup/model/roles/character",
		MODEL_ROLES_CHARACTER_SCOPED: (id: string) =>
			`api/setup/model/roles/character/${encodeURIComponent(id)}`,
		MODEL_ROLES_AGENT_SCOPED: (id: string) =>
			`api/setup/model/roles/agent/${encodeURIComponent(id)}`,
		MODEL_ROLES_PROFESSIONAL: "api/setup/model/roles/professional",
		MODEL_ROLES_PROFESSIONAL_TASK: (taskType: string) =>
			`api/setup/model/roles/professional/${encodeURIComponent(taskType)}`,
		MODEL_ACTIVE: "api/setup/model/active",
		MODEL_REORDER: "api/setup/model/reorder",
		MODEL_DETAIL: (id: string) => `api/setup/model/${id}`,
		PROGRESS: "api/setup/progress",
		RUN: "api/setup/run",
		DEFAULT_MODELS: "api/setup/default-models",
		REQUIREMENTS: "api/setup/requirements",
		FINISH: "api/setup/finish",
		INIT: "api/setup/init",
		PREFLIGHT: "api/setup/preflight",
	},
	MCP: {
		STATUS: "api/mcp/status",
		CONFIG: "api/mcp/config",
		POLICY: "api/mcp/policy",
		STORE: (params?: string) =>
			params ? `api/mcp/store?${params}` : "api/mcp/store",
		INSTALL_PREVIEW: "api/mcp/install/preview",
		INSTALL_CONFIRM: "api/mcp/install/confirm",
		SERVER_ENABLE: (name: string) =>
			`api/mcp/servers/${encodeURIComponent(name)}/enable`,
		SERVER_DISABLE: (name: string) =>
			`api/mcp/servers/${encodeURIComponent(name)}/disable`,
		SERVER_DELETE: (name: string) =>
			`api/mcp/servers/${encodeURIComponent(name)}`,
	},
	CONFIG: {
		GET: "api/config",
		UPDATE: "api/config",
		ROTATE_SECRETS: "api/config/secrets/rotate",
	},
	SECURITY: {
		LOCKDOWN: "api/security/lockdown",
		PERMISSIONS: "api/security/permissions",
		PERMISSION: (kind: string, name: string) =>
			`api/security/permissions/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`,
		AUDIT_VERIFY: "api/security/audit/verify",
	},
	CREDENTIALS: {
		STATUS: "api/credentials/status",
		ROTATE: "api/credentials/rotate",
	},
	BACKUP: {
		EXPORT: "api/backup/export",
		IMPORT: "api/backup/import",
	},
	TOOLS: "api/tools",
	MEMORY: {
		COMPRESS: "api/memory/compress",
		DECAY: "api/memory/decay",
	},
};
