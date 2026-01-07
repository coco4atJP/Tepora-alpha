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
});
