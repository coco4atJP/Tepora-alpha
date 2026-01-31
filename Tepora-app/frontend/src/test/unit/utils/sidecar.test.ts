import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("../../../utils/api", () => ({
	getApiBase: vi.fn(),
	getAuthHeadersAsync: vi.fn(),
	isDesktop: () =>
		typeof window !== "undefined" &&
		!!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
	setDynamicPort: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
	exit: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
	Command: {
		sidecar: vi.fn(),
	},
}));

describe("sidecar utils", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		// Reset window.__TAURI_INTERNALS__ to undefined (Web mode default)

		delete window.__TAURI_INTERNALS__;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should resolve backendReady with default port 8000 in Web mode", async () => {
		// Ensure Web mode

		expect(window.__TAURI_INTERNALS__).toBeUndefined();

		// Dynamically import to get a fresh module instance
		const { startSidecar, backendReady } = await import("../../../utils/sidecar");

		// Start sidecar
		await startSidecar();

		// Verify backendReady resolves to 8000
		await expect(backendReady).resolves.toBe(8000);
	});

	it("should reset sidecarStarting flag when returning early in Web mode", async () => {
		// Ensure Web mode

		expect(window.__TAURI_INTERNALS__).toBeUndefined();

		const { startSidecar } = await import("../../../utils/sidecar");

		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		// First call
		await startSidecar();
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Not running in Desktop mode"));

		consoleSpy.mockClear();

		// Second call - should not be blocked by "Already starting" check
		await startSidecar();

		expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("Already starting"));
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Not running in Desktop mode"));
	});
});
