import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ApiClient } from "../../../shared/lib/api-client";
import {
	useAgentSkillsQuery,
	useCredentialStatusesQuery,
	useMcpInstallConfirmMutation,
	useSaveAgentSkillMutation,
} from "./queries";

vi.mock("../../../shared/lib/api-client", () => ({
	v2ApiClient: {
		get: vi.fn(),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
	},
}));

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				gcTime: 0,
			},
			mutations: {
				retry: 0,
			},
		},
	});

	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	};
}

describe("settings queries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("loads credential statuses", async () => {
		vi.mocked(v2ApiClient.get).mockResolvedValue({
			credentials: [
				{
					provider: "google_search",
					status: "active",
					present: true,
					expires_at: "2026-04-01T00:00:00.000Z",
					last_rotated_at: "2026-03-20T00:00:00.000Z",
				},
			],
		});

		const { result } = renderHook(() => useCredentialStatusesQuery(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.credentials[0]?.provider).toBe("google_search");
	});

	it("loads agent skills via the v2 hook", async () => {
		vi.mocked(v2ApiClient.get).mockResolvedValue({
			roots: [],
			skills: [
				{
					id: "skill-1",
					name: "skill-1",
					description: "Skill description",
					package_dir: "/tmp/skill-1",
					root_path: "/tmp",
					metadata: {},
					valid: true,
					writable: true,
					warnings: [],
				},
			],
		});

		const { result } = renderHook(() => useAgentSkillsQuery(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.skills[0]?.id).toBe("skill-1");
	});

	it("saves an agent skill package", async () => {
		vi.mocked(v2ApiClient.post).mockResolvedValue({
			success: true,
			skill: {
				id: "skill-saved",
				name: "skill-saved",
				description: "Saved skill",
				package_dir: "/tmp/skill-saved",
				root_path: "/tmp",
				metadata: {},
				valid: true,
				writable: true,
				warnings: [],
				skill_markdown: "---\nname: skill-saved\n---",
				skill_body: "",
				openai_yaml: "",
				references: [],
				scripts: [],
				assets: [],
				other_files: [],
			},
		});

		const { result } = renderHook(() => useSaveAgentSkillMutation(), {
			wrapper: createWrapper(),
		});

		let response:
			| Awaited<ReturnType<typeof result.current.mutateAsync>>
			| undefined;
		await act(async () => {
			response = await result.current.mutateAsync({
				id: "skill-saved",
				root_path: "/tmp",
				skill_markdown: "---\nname: skill-saved\n---",
				openai_yaml: "",
				references: [],
				scripts: [],
				assets: [],
				other_files: [],
			});
		});

		expect(response?.skill.id).toBe("skill-saved");
	});

	it("confirms MCP install flow", async () => {
		vi.mocked(v2ApiClient.post).mockResolvedValue({
			status: "success",
			server_name: "filesystem",
			message: "installed",
		});

		const { result } = renderHook(() => useMcpInstallConfirmMutation(), {
			wrapper: createWrapper(),
		});

		let response:
			| Awaited<ReturnType<typeof result.current.mutateAsync>>
			| undefined;
		await act(async () => {
			response = await result.current.mutateAsync("consent-123");
		});
		expect(response?.server_name).toBe("filesystem");
		expect(v2ApiClient.post).toHaveBeenCalledWith(
			"/api/mcp/install/confirm",
			expect.anything(),
			{ consent_id: "consent-123" },
		);
	});
});
