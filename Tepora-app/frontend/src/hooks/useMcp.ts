/**
 * useMcp - Custom React hooks for MCP management
 *
 * Provides:
 * - useMcpServers: Get configured servers and their status
 * - useMcpStore: Browse and search available servers from registry
 * - useMcpConfig: Update MCP configuration
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBase, getAuthHeaders } from "../utils/api";

const SEARCH_DEBOUNCE_MS = 300;

// --- Types ---

export interface McpServerStatus {
	status: "connected" | "disconnected" | "error" | "connecting";
	tools_count: number;
	error_message?: string | null;
	last_connected?: string | null;
}

export interface McpServerConfig {
	command: string;
	args: string[];
	env: Record<string, string>;
	enabled: boolean;
	metadata?: {
		name?: string;
		description?: string;
	} | null;
}

export interface McpEnvVar {
	name: string;
	description?: string;
	isRequired: boolean;
	isSecret: boolean;
	default?: string;
}

export interface McpPackage {
	name: string;
	runtimeHint?: string;
	registry?: string;
}

export interface McpStoreServer {
	id: string;
	name: string;
	description?: string;
	vendor?: string;
	packages: McpPackage[];
	environmentVariables: McpEnvVar[];
	icon?: string;
	category?: string;
	sourceUrl?: string;
}

/** Response from install preview endpoint */
export interface McpInstallPreview {
	consent_id: string;
	expires_in_seconds: number;
	server_id: string;
	server_name: string;
	description?: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	full_command: string;
	warnings: string[];
	requires_consent: boolean;
	runtime?: string;
}

// --- API Functions ---

async function fetchMcpStatus(): Promise<Record<string, McpServerStatus>> {
	const response = await fetch(`${getApiBase()}/api/mcp/status`, {
		headers: getAuthHeaders(),
	});
	if (!response.ok) throw new Error("Failed to fetch MCP status");
	const data = await response.json();
	return data.servers || {};
}

async function fetchMcpConfig(): Promise<Record<string, McpServerConfig>> {
	const response = await fetch(`${getApiBase()}/api/mcp/config`, {
		headers: getAuthHeaders(),
	});
	if (!response.ok) throw new Error("Failed to fetch MCP config");
	const data = await response.json();
	return data.mcpServers || {};
}

async function updateMcpConfig(
	config: Record<string, McpServerConfig>,
): Promise<void> {
	const response = await fetch(`${getApiBase()}/api/mcp/config`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...getAuthHeaders(),
		},
		body: JSON.stringify({ mcpServers: config }),
	});
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || "Failed to update config");
	}
}

async function fetchMcpStore(search?: string): Promise<McpStoreServer[]> {
	const url = search
		? `${getApiBase()}/api/mcp/store?search=${encodeURIComponent(search)}`
		: `${getApiBase()}/api/mcp/store`;
	const response = await fetch(url, {
		headers: getAuthHeaders(),
	});
	if (!response.ok) throw new Error("Failed to fetch MCP store");
	const data = await response.json();
	return data.servers || [];
}

/**
 * Step 1: Preview MCP server installation.
 * Returns command details and security warnings for user review.
 */
async function previewMcpInstall(
	serverId: string,
	runtime?: string,
	envValues?: Record<string, string>,
	serverName?: string,
): Promise<McpInstallPreview> {
	const response = await fetch(`${getApiBase()}/api/mcp/install/preview`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...getAuthHeaders(),
		},
		body: JSON.stringify({
			server_id: serverId,
			runtime,
			env_values: envValues,
			server_name: serverName,
		}),
	});
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.detail || error.error || "Failed to preview install");
	}
	return response.json();
}

/**
 * Step 2: Confirm MCP server installation after user consent.
 */
async function confirmMcpInstall(
	consentId: string,
): Promise<{ status: string; server_name: string; message: string }> {
	const response = await fetch(`${getApiBase()}/api/mcp/install/confirm`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...getAuthHeaders(),
		},
		body: JSON.stringify({ consent_id: consentId }),
	});
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.detail || error.error || "Failed to confirm install");
	}
	return response.json();
}

async function enableServer(serverName: string): Promise<void> {
	const response = await fetch(
		`${getApiBase()}/api/mcp/servers/${encodeURIComponent(serverName)}/enable`,
		{
			method: "POST",
			headers: getAuthHeaders(),
		},
	);
	if (!response.ok) throw new Error("Failed to enable server");
}

async function disableServer(serverName: string): Promise<void> {
	const response = await fetch(
		`${getApiBase()}/api/mcp/servers/${encodeURIComponent(serverName)}/disable`,
		{
			method: "POST",
			headers: getAuthHeaders(),
		},
	);
	if (!response.ok) throw new Error("Failed to disable server");
}

async function deleteServer(serverName: string): Promise<void> {
	const response = await fetch(
		`${getApiBase()}/api/mcp/servers/${encodeURIComponent(serverName)}`,
		{
			method: "DELETE",
			headers: getAuthHeaders(),
		},
	);
	if (!response.ok) throw new Error("Failed to delete server");
}

// --- Hooks ---

/**
 * Hook for managing configured MCP servers and their status
 */
export function useMcpServers(pollInterval = 5000) {
	const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
	const [status, setStatus] = useState<Record<string, McpServerStatus>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchData = useCallback(async () => {
		try {
			const [configData, statusData] = await Promise.all([
				fetchMcpConfig(),
				fetchMcpStatus(),
			]);
			setServers(configData);
			setStatus(statusData);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setLoading(false);
		}
	}, []);

	// Initial fetch
	useEffect(() => {
		fetchData();
	}, [fetchData]);

	// Polling for status updates
	useEffect(() => {
		if (pollInterval > 0) {
			pollingRef.current = setInterval(async () => {
				try {
					const statusData = await fetchMcpStatus();
					setStatus(statusData);
				} catch {
					// Silent fail for polling
				}
			}, pollInterval);
		}
		return () => {
			if (pollingRef.current) {
				clearInterval(pollingRef.current);
			}
		};
	}, [pollInterval]);

	const toggleServer = useCallback(
		async (serverName: string, enabled: boolean) => {
			try {
				if (enabled) {
					await enableServer(serverName);
				} else {
					await disableServer(serverName);
				}
				await fetchData();
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to toggle server",
				);
			}
		},
		[fetchData],
	);

	const removeServer = useCallback(
		async (serverName: string) => {
			try {
				await deleteServer(serverName);
				await fetchData();
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to remove server",
				);
			}
		},
		[fetchData],
	);

	return {
		servers,
		status,
		loading,
		error,
		refresh: fetchData,
		toggleServer,
		removeServer,
	};
}

/**
 * Hook for browsing and installing from MCP store
 */
export function useMcpStore() {
	const [storeServers, setStoreServers] = useState<McpStoreServer[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");

	const fetchStore = useCallback(async (search?: string) => {
		setLoading(true);
		try {
			const servers = await fetchMcpStore(search);
			setStoreServers(servers);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch store");
		} finally {
			setLoading(false);
		}
	}, []);

	// Debounced search
	useEffect(() => {
		const timer = setTimeout(() => {
			fetchStore(searchQuery || undefined);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [searchQuery, fetchStore]);

	const previewInstall = useCallback(
		async (
			serverId: string,
			runtime?: string,
			envValues?: Record<string, string>,
			serverName?: string,
		) => {
			return previewMcpInstall(serverId, runtime, envValues, serverName);
		},
		[],
	);

	const confirmInstall = useCallback(async (consentId: string) => {
		return confirmMcpInstall(consentId);
	}, []);

	return {
		storeServers,
		loading,
		error,
		searchQuery,
		setSearchQuery,
		refresh: () => fetchStore(searchQuery || undefined),
		previewInstall,
		confirmInstall,
	};
}

/**
 * Hook for direct config updates
 */
export function useMcpConfig() {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const saveConfig = useCallback(
		async (config: Record<string, McpServerConfig>) => {
			setSaving(true);
			setError(null);
			try {
				await updateMcpConfig(config);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to save config");
				throw err;
			} finally {
				setSaving(false);
			}
		},
		[],
	);

	return {
		saving,
		error,
		saveConfig,
	};
}

// --- Policy Hooks ---

export interface McpPolicyConfig {
	policy: string;
	server_permissions: Record<string, unknown>;
	blocked_commands: string[];
	require_tool_confirmation: boolean;
	first_use_confirmation: boolean;
}

export interface McpPolicyUpdate {
	policy?: string;
	require_tool_confirmation?: boolean;
	first_use_confirmation?: boolean;
}

async function fetchMcpPolicy(): Promise<McpPolicyConfig> {
	const response = await fetch(`${getApiBase()}/api/mcp/policy`, {
		headers: getAuthHeaders(),
	});
	if (!response.ok) throw new Error("Failed to fetch MCP policy");
	return response.json();
}

async function updateMcpPolicy(update: McpPolicyUpdate): Promise<void> {
	const response = await fetch(`${getApiBase()}/api/mcp/policy`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			...getAuthHeaders(),
		},
		body: JSON.stringify(update),
	});
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.detail || "Failed to update policy");
	}
}

/**
 * Hook for managing MCP security policy
 */
export function useMcpPolicy() {
	const [policy, setPolicy] = useState<McpPolicyConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const fetchPolicy = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchMcpPolicy();
			setPolicy(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch policy");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchPolicy();
	}, [fetchPolicy]);

	const updatePolicy = useCallback(
		async (update: McpPolicyUpdate) => {
			setSaving(true);
			try {
				await updateMcpPolicy(update);
				await fetchPolicy();
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to update policy",
				);
				throw err;
			} finally {
				setSaving(false);
			}
		},
		[fetchPolicy],
	);

	return {
		policy,
		loading,
		error,
		saving,
		updatePolicy,
		refresh: fetchPolicy,
	};
}
