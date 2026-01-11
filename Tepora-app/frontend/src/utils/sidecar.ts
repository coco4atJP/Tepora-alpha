import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { type Child, Command } from "@tauri-apps/plugin-shell";
import { getApiBase, getAuthHeadersAsync, setDynamicPort } from "./api";

// Helper to detect if running in Tauri
export const isDesktop = () => {
	return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
};

// Backend ready promise for coordinated startup
let backendReadyResolve: ((port: number) => void) | null = null;
let backendPort: number | null = null;

// Store the sidecar child process for termination
let sidecarChild: Child | null = null;

let closeHandlerRegistered = false;
let shutdownInProgress = false;

let sidecarExited: Promise<void> | null = null;
let resolveSidecarExited: (() => void) | null = null;

function resetSidecarExitPromise(): void {
	sidecarExited = new Promise((resolve) => {
		resolveSidecarExited = resolve;
	});
}

function markSidecarExited(): void {
	if (resolveSidecarExited) {
		resolveSidecarExited();
		resolveSidecarExited = null;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const backendReady: Promise<number> = new Promise((resolve) => {
	backendReadyResolve = resolve;
});

export function getBackendPort(): number | null {
	return backendPort;
}

/**
 * Stop the sidecar process gracefully
 */
export async function stopSidecar(): Promise<void> {
	if (sidecarChild) {
		try {
			console.log("[Sidecar] Terminating backend process...");
			await sidecarChild.kill();
			console.log("[Sidecar] Backend process terminated.");
			sidecarChild = null;
		} catch (error) {
			console.error("[Sidecar] Failed to terminate backend:", error);
		}
	}
}

export async function startSidecar() {
	if (!isDesktop()) {
		console.log(
			"[Sidecar] Not running in Desktop mode (Tauri), skipping sidecar startup.",
		);
		// For web mode, resolve with default port
		if (backendReadyResolve) {
			backendReadyResolve(8000);
			setDynamicPort(8000);
		}
		return;
	}

	// Ensure we always attempt cleanup on window close (even if backend was already running)
	if (!closeHandlerRegistered) {
		closeHandlerRegistered = true;
		try {
			const appWindow = getCurrentWindow();
			await appWindow.onCloseRequested(async (event) => {
				event.preventDefault();

				if (shutdownInProgress) return;
				shutdownInProgress = true;

				console.log(
					"[Sidecar] Window close requested, shutting down backend...",
				);

				// 1) Ask backend to shutdown gracefully (requires x-api-key)
				if (backendPort) {
					try {
						const headers = await getAuthHeadersAsync();
						const res = await fetch(
							`http://127.0.0.1:${backendPort}/api/shutdown`,
							{
								method: "POST",
								headers,
								signal: AbortSignal.timeout(800),
							},
						);
						if (!res.ok) {
							console.warn(
								`[Sidecar] Backend shutdown request failed: ${res.status}`,
							);
						} else {
							console.log("[Sidecar] Shutdown request sent to backend.");
						}
					} catch (error) {
						console.log(
							"[Sidecar] Backend shutdown request completed or timed out.",
							error,
						);
					}
				}

				// 2) Give it a moment to exit on its own, then force-kill as a fallback
				try {
					const exited = await Promise.race([
						sidecarExited?.then(() => true) ?? Promise.resolve(false),
						delay(1200).then(() => false),
					]);
					if (!exited) {
						await stopSidecar();
					}
				} catch (error) {
					console.warn(
						"[Sidecar] Failed while waiting for backend exit:",
						error,
					);
					await stopSidecar();
				}

				// 3) Exit the app process
				try {
					await exit(0);
				} catch {
					// exit呼び出しが失敗しても問題ない（既に終了中）
				}
			});
			console.log("[Sidecar] Window close handler registered.");
		} catch (err) {
			console.warn("[Sidecar] Failed to register window close handler:", err);
		}
	}

	try {
		// Check if backend is already running on any common port
		for (const testPort of [8000, 8001, 8002]) {
			try {
				const response = await fetch(`http://127.0.0.1:${testPort}/health`);
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

		console.log("[Sidecar] Starting backend sidecar...");
		// Note: Tauri will look for tepora-backend-target-triple(.exe)
		const command = Command.sidecar("binaries/tepora-backend");
		resetSidecarExitPromise();

		command.on("close", (data) => {
			console.log(
				`[Sidecar] finished with code ${data.code} and signal ${data.signal}`,
			);
			sidecarChild = null;
			markSidecarExited();
		});
		command.on("error", (error) =>
			console.error(`[Sidecar] error: "${error}"`),
		);

		// Parse TEPORA_PORT from stdout
		command.stdout.on("data", async (line) => {
			console.log(`[Backend]: ${line}`);
			const portMatch = line.match(/TEPORA_PORT=(\d+)/);
			if (portMatch) {
				const port = parseInt(portMatch[1], 10);
				console.log(
					`[Sidecar] Backend port confirmed: ${port}. Waiting for health check...`,
				);
				backendPort = port;
				setDynamicPort(port);

				// Wait for the server to actually start listening (since port is printed before heavy init)
				const startWait = Date.now();
				while (Date.now() - startWait < 30000) {
					// 30s timeout for startup
					try {
						const res = await fetch(`http://127.0.0.1:${port}/health`);
						if (res.ok) {
							console.log("[Sidecar] Backend health check passed. Ready.");
							if (backendReadyResolve) {
								backendReadyResolve(port);
								backendReadyResolve = null;
							}
							break;
						}
					} catch {
						// wait and retry
					}
					await new Promise((r) => setTimeout(r, 500));
				}
			}
		});
		command.stderr.on("data", (line) =>
			console.error(`[Backend Error]: ${line}`),
		);

		const child = await command.spawn();
		sidecarChild = child; // Store reference for termination
		console.log("[Sidecar] Backend spawned with PID:", child.pid);

		// Wait for port detection with timeout
		const timeoutMs = 30000;
		const startTime = Date.now();
		while (!backendPort && Date.now() - startTime < timeoutMs) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		if (!backendPort) {
			console.warn(
				"[Sidecar] Timeout waiting for port, falling back to checking health endpoints",
			);
			// Fallback: try to detect port by checking health
			for (let testPort = 8000; testPort < 8100; testPort++) {
				try {
					const response = await fetch(`http://127.0.0.1:${testPort}/health`, {
						signal: AbortSignal.timeout(1000),
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
		console.error("[Sidecar] Failed to start sidecar:", error);
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
