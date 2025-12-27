import { Command } from '@tauri-apps/plugin-shell';
import { setDynamicPort, getApiBase } from './api';

// Helper to detect if running in Tauri
export const isDesktop = () => {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
};

// Backend ready promise for coordinated startup
let backendReadyResolve: ((port: number) => void) | null = null;
let backendPort: number | null = null;

export const backendReady: Promise<number> = new Promise((resolve) => {
    backendReadyResolve = resolve;
});

export function getBackendPort(): number | null {
    return backendPort;
}

export async function startSidecar() {
    if (!isDesktop()) {
        console.log('[Sidecar] Not running in Desktop mode (Tauri), skipping sidecar startup.');
        // For web mode, resolve with default port
        if (backendReadyResolve) {
            backendReadyResolve(8000);
            setDynamicPort(8000);
        }
        return;
    }

    try {
        // Check if backend is already running on any common port
        for (const testPort of [8000, 8001, 8002]) {
            try {
                const response = await fetch(`http://localhost:${testPort}/health`);
                if (response.ok) {
                    console.log(`[Sidecar] Backend already running on port ${testPort}`);
                    backendPort = testPort;
                    setDynamicPort(testPort);
                    if (backendReadyResolve) {
                        backendReadyResolve(testPort);
                    }
                    return;
                }
            } catch {
                // Port not available, continue
            }
        }

        console.log('[Sidecar] Starting backend sidecar...');
        // Note: Tauri will look for tepora-backend-target-triple(.exe)
        const command = Command.sidecar('tepora-backend');

        command.on('close', data => {
            console.log(`[Sidecar] finished with code ${data.code} and signal ${data.signal}`);
        });
        command.on('error', error => console.error(`[Sidecar] error: "${error}"`));

        // Parse TEPORA_PORT from stdout
        command.stdout.on('data', line => {
            console.log(`[Backend]: ${line}`);
            const portMatch = line.match(/TEPORA_PORT=(\d+)/);
            if (portMatch) {
                const port = parseInt(portMatch[1], 10);
                console.log(`[Sidecar] Backend port detected: ${port}`);
                backendPort = port;
                setDynamicPort(port);
                if (backendReadyResolve) {
                    backendReadyResolve(port);
                    backendReadyResolve = null;
                }
            }
        });
        command.stderr.on('data', line => console.error(`[Backend Error]: ${line}`));

        const child = await command.spawn();
        console.log('[Sidecar] Backend spawned with PID:', child.pid);

        // Wait for port detection with timeout
        const timeoutMs = 30000;
        const startTime = Date.now();
        while (!backendPort && (Date.now() - startTime) < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!backendPort) {
            console.warn('[Sidecar] Timeout waiting for port, falling back to checking health endpoints');
            // Fallback: try to detect port by checking health
            for (let testPort = 8000; testPort < 8100; testPort++) {
                try {
                    const response = await fetch(`http://localhost:${testPort}/health`, {
                        signal: AbortSignal.timeout(1000)
                    });
                    if (response.ok) {
                        backendPort = testPort;
                        setDynamicPort(testPort);
                        if (backendReadyResolve) {
                            backendReadyResolve(testPort);
                        }
                        break;
                    }
                } catch {
                    // Continue
                }
            }
        }

    } catch (error) {
        console.error('[Sidecar] Failed to start sidecar:', error);
    }
}

/**
 * Health check using the dynamic port
 */
export async function checkBackendHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${getApiBase()}/health`);
        return response.ok;
    } catch {
        return false;
    }
}
