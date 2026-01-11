import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpServers, useMcpStore } from "../../../hooks/useMcp";

describe("useMcpServers", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fetches servers and status", async () => {
		vi.mocked(fetch).mockImplementation(async (url) => {
			const urlStr = url.toString();
			if (urlStr.endsWith("/api/mcp/config")) {
				return {
					ok: true,
					json: async () => ({
						mcpServers: {
							server1: { command: "cmd", args: [], env: {}, enabled: true },
						},
					}),
				} as Response;
			}
			if (urlStr.endsWith("/api/mcp/status")) {
				return {
					ok: true,
					json: async () => ({
						servers: {
							server1: { status: "connected", tools_count: 5 },
						},
					}),
				} as Response;
			}
			return { ok: false, status: 404 } as Response;
		});

		const { result } = renderHook(() => useMcpServers(0));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.servers.server1).toBeDefined();
		expect(result.current.status.server1?.status).toBe("connected");
		expect(result.current.error).toBeNull();
	});
});

describe("useMcpStore", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fetches store items", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				servers: [
					{
						id: "srv1",
						name: "Server 1",
						packages: [],
						environmentVariables: [],
					},
				],
			}),
		} as Response);

		const { result } = renderHook(() => useMcpStore());

		// Trigger fetch
		result.current.refresh();

		await waitFor(() => {
			expect(result.current.storeServers).toHaveLength(1);
		});

		expect(result.current.storeServers[0].name).toBe("Server 1");
	});

	it("previewInstall calls preview endpoint", async () => {
		vi.mocked(fetch).mockImplementation(async (url) => {
			const urlStr = url.toString();
			if (urlStr.includes("/api/mcp/store")) {
				return {
					ok: true,
					json: async () => ({ servers: [] }),
				} as Response;
			}
			if (urlStr.includes("/api/mcp/install/preview")) {
				return {
					ok: true,
					json: async () => ({
						consent_id: "test-consent-123",
						expires_in_seconds: 300,
						server_id: "test-server",
						server_name: "Test Server",
						command: "npx",
						args: ["-y", "@test/server"],
						env: {},
						full_command: "npx -y @test/server",
						warnings: ["External npm package download"],
						requires_consent: true,
					}),
				} as Response;
			}
			return { ok: false, status: 404 } as Response;
		});

		const { result } = renderHook(() => useMcpStore());

		// Wait for initial fetch
		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		// Call previewInstall
		const preview = await result.current.previewInstall("test-server", "npx");

		expect(preview.consent_id).toBe("test-consent-123");
		expect(preview.full_command).toBe("npx -y @test/server");
		expect(preview.warnings).toContain("External npm package download");
	});

	it("confirmInstall calls confirm endpoint", async () => {
		vi.mocked(fetch).mockImplementation(async (url) => {
			const urlStr = url.toString();
			if (urlStr.includes("/api/mcp/store")) {
				return {
					ok: true,
					json: async () => ({ servers: [] }),
				} as Response;
			}
			if (urlStr.includes("/api/mcp/install/confirm")) {
				return {
					ok: true,
					json: async () => ({
						status: "success",
						server_name: "test-server",
						message: "Server installed successfully",
					}),
				} as Response;
			}
			return { ok: false, status: 404 } as Response;
		});

		const { result } = renderHook(() => useMcpStore());

		// Wait for initial fetch
		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		// Call confirmInstall
		const response = await result.current.confirmInstall("test-consent-123");

		expect(response.status).toBe("success");
		expect(response.server_name).toBe("test-server");
	});
});
