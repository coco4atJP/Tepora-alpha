import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { v2ApiClient } from "../../../shared/lib/api-client";
import {
	useCreateSessionMutation,
	useV2SessionsQuery,
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

describe("session queries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("loads sessions through the v2 query hook", async () => {
		vi.mocked(v2ApiClient.get).mockResolvedValue({
			sessions: [
				{
					id: "session-1",
					title: "Session 1",
					created_at: "2026-03-17T00:00:00.000Z",
					updated_at: "2026-03-17T00:00:00.000Z",
				},
			],
		});

		const { result } = renderHook(() => useV2SessionsQuery(), {
			wrapper: createWrapper(),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.[0]?.id).toBe("session-1");
	});

	it("writes the created session into the cached list", async () => {
		vi.mocked(v2ApiClient.post).mockResolvedValue({
			session: {
				id: "session-created",
				title: null,
				created_at: "2026-03-17T00:00:00.000Z",
				updated_at: "2026-03-17T00:00:00.000Z",
			},
		});

		const { result } = renderHook(() => useCreateSessionMutation(), {
			wrapper: createWrapper(),
		});

		let createdSession:
			| {
					id: string;
					title: string | null;
					created_at: string;
					updated_at: string;
			  }
			| undefined;
		await actAsync(async () => {
			createdSession = await result.current.mutateAsync(null);
		});

		expect(createdSession?.id).toBe("session-created");
	});
});

async function actAsync(run: () => Promise<void>) {
	await run();
}
