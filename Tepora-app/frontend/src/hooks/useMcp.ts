/**
 * useMcp - Custom React hooks for MCP management
 * 
 * Provides:
 * - useMcpServers: Get configured servers and their status
 * - useMcpStore: Browse and search available servers from registry
 * - useMcpConfig: Update MCP configuration
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getAuthHeaders } from '../utils/api';

// --- Types ---

export interface McpServerStatus {
    status: 'connected' | 'disconnected' | 'error' | 'connecting';
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

// --- API Functions ---

const API_BASE = '/api/mcp';

async function fetchMcpStatus(): Promise<Record<string, McpServerStatus>> {
    const response = await fetch(`${API_BASE}/status`, {
        headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to fetch MCP status');
    const data = await response.json();
    return data.servers || {};
}

async function fetchMcpConfig(): Promise<Record<string, McpServerConfig>> {
    const response = await fetch(`${API_BASE}/config`, {
        headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to fetch MCP config');
    const data = await response.json();
    return data.mcpServers || {};
}

async function updateMcpConfig(config: Record<string, any>): Promise<void> {
    const response = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
        },
        body: JSON.stringify({ mcpServers: config }),
    });
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update config');
    }
}

async function fetchMcpStore(search?: string): Promise<McpStoreServer[]> {
    const url = search ? `${API_BASE}/store?search=${encodeURIComponent(search)}` : `${API_BASE}/store`;
    const response = await fetch(url, {
        headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to fetch MCP store');
    const data = await response.json();
    return data.servers || [];
}

async function installMcpServer(
    serverId: string,
    runtime?: string,
    envValues?: Record<string, string>,
    serverName?: string
): Promise<{ server_name: string }> {
    const response = await fetch(`${API_BASE}/install`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
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
        throw new Error(error.error || 'Failed to install server');
    }
    return response.json();
}

async function enableServer(serverName: string): Promise<void> {
    const response = await fetch(`${API_BASE}/servers/${encodeURIComponent(serverName)}/enable`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to enable server');
}

async function disableServer(serverName: string): Promise<void> {
    const response = await fetch(`${API_BASE}/servers/${encodeURIComponent(serverName)}/disable`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to disable server');
}

async function deleteServer(serverName: string): Promise<void> {
    const response = await fetch(`${API_BASE}/servers/${encodeURIComponent(serverName)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    if (!response.ok) throw new Error('Failed to delete server');
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
            setError(err instanceof Error ? err.message : 'Unknown error');
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

    const toggleServer = useCallback(async (serverName: string, enabled: boolean) => {
        try {
            if (enabled) {
                await enableServer(serverName);
            } else {
                await disableServer(serverName);
            }
            await fetchData();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to toggle server');
        }
    }, [fetchData]);

    const removeServer = useCallback(async (serverName: string) => {
        try {
            await deleteServer(serverName);
            await fetchData();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to remove server');
        }
    }, [fetchData]);

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
    const [searchQuery, setSearchQuery] = useState('');

    const fetchStore = useCallback(async (search?: string) => {
        setLoading(true);
        try {
            const servers = await fetchMcpStore(search);
            setStoreServers(servers);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch store');
        } finally {
            setLoading(false);
        }
    }, []);

    // Debounced search
    useEffect(() => {
        const timer = setTimeout(() => {
            fetchStore(searchQuery || undefined);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery, fetchStore]);

    const install = useCallback(async (
        serverId: string,
        runtime?: string,
        envValues?: Record<string, string>,
        serverName?: string
    ) => {
        return installMcpServer(serverId, runtime, envValues, serverName);
    }, []);

    return {
        storeServers,
        loading,
        error,
        searchQuery,
        setSearchQuery,
        refresh: () => fetchStore(searchQuery || undefined),
        install,
    };
}

/**
 * Hook for direct config updates
 */
export function useMcpConfig() {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const saveConfig = useCallback(async (config: Record<string, any>) => {
        setSaving(true);
        setError(null);
        try {
            await updateMcpConfig(config);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save config');
            throw err;
        } finally {
            setSaving(false);
        }
    }, []);

    return {
        saving,
        error,
        saveConfig,
    };
}
