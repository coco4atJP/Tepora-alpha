import { Command } from '@tauri-apps/plugin-shell';

// Helper to detect if running in Tauri
export const isDesktop = () => {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
};

export async function startSidecar() {
    if (!isDesktop()) {
        console.log('[Sidecar] Not running in Desktop mode (Tauri), skipping sidecar startup.');
        return;
    }

    try {
        // Check if backend is already running
        try {
            const response = await fetch('http://localhost:8000/health');
            if (response.ok) {
                console.log('Backend already running');
                return;
            }
        } catch {
            // Backend not running, proceed to spawn
        }

        console.log('Starting backend sidecar...');
        // Note: Tauri will look for tepora-backend-target-triple(.exe)
        const command = Command.sidecar('tepora-backend');

        command.on('close', data => {
            console.log(`[Sidecar] finished with code ${data.code} and signal ${data.signal}`);
        });
        command.on('error', error => console.error(`[Sidecar] error: "${error}"`));
        command.stdout.on('data', line => console.log(`[Backend]: ${line}`));
        command.stderr.on('data', line => console.error(`[Backend Error]: ${line}`));

        const child = await command.spawn();
        console.log('[Sidecar] Backend spawned with PID:', child.pid);

    } catch (error) {
        console.error('[Sidecar] Failed to start sidecar:', error);
    }
}
