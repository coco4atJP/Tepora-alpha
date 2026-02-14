/**
 * Centralized API Endpoints
 */

export const ENDPOINTS = {
	HEALTH: "health",
	SHUTDOWN: "api/shutdown",
	SESSIONS: {
		LIST: "api/sessions", // GET for list, POST for create
		DETAIL: (id: string) => `api/sessions/${id}`, // DELETE, PATCH
	},
	LOADERS: {
		OLLAMA: {
			REFRESH: "api/setup/models/ollama/refresh",
		},
		LMSTUDIO: {
			REFRESH: "api/setup/models/lmstudio/refresh",
		},
	},
};
