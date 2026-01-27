import { beforeEach, describe, expect, it, vi } from "vitest";
import { startSidecar } from "../../../utils/sidecar";

// Mocks
vi.mock("../../../utils/sidecar", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../utils/sidecar")>();
	return {
		...actual,
		isDesktop: vi.fn(),
		// Mock other dependencies to avoid side effects
		setDynamicPort: vi.fn(),
		getAuthHeadersAsync: vi.fn(),
		checkBackendHealth: vi.fn(),
	};
});

// Import the mocked module to access the mock function
import { isDesktop } from "../../../utils/sidecar";

describe("startSidecar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should reset sidecarStarting flag when returning early in non-desktop mode", async () => {
		// Setup: Mock isDesktop to return false (Web mode)
		vi.mocked(isDesktop).mockReturnValue(false);

		// First call: Should log "Not running in Desktop mode" and return
		// We can't easily spy on the internal sidecarStarting variable,
		// but we can check if a second call works or is ignored.

		// Spy on console.log to verify behavior
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		// 1. Call startSidecar first time
		await startSidecar();

		// Verify it hit the non-desktop path
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Not running in Desktop mode"),
		);
		consoleSpy.mockClear();

		// 2. Call startSidecar second time
		// If the bug exists (flag not reset), this will verify the "Already starting" log or just simply not hit the "Not running" log again?
		// Actually, if the bug exists, sidecarStarting remains true.
		// The function checks `if (sidecarStarting) ... return;` at the very top.
		// So checking if we hit "Not running in Desktop mode" again is a valid test.

		await startSidecar();

		// Expectation: It should NOT log "Already starting"
		expect(consoleSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("Already starting"),
		);

		// Expectation: It SHOULD log "Not running in Desktop mode" again because the flag should have been reset
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Not running in Desktop mode"),
		);
	});
});
