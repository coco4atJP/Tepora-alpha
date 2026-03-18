import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { V2Workspace } from "../app/V2Workspace";
import { useWorkspaceStore } from "../app/model/workspaceStore";
import { V2ApiError, v2ApiClient } from "../shared/lib/api-client";
import { consentRequiredErrorResponseSchema } from "../shared/contracts";
import { v2TransportAdapter } from "../shared/lib/transportAdapter";

vi.mock("../shared/lib/api-client", () => ({
	v2ApiClient: {
		get: vi.fn(),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
	},
	V2ApiError: class extends Error {
		readonly status: number;
		readonly data: unknown;

		constructor(message: string, status: number, data: unknown) {
			super(message);
			this.status = status;
			this.data = data;
		}
	},
}));

vi.mock("../shared/lib/transportAdapter", () => {
	type Subscriber = (message: unknown) => void;
	type ConnectionSubscriber = (snapshot: unknown) => void;

	const subscribers = new Set<Subscriber>();
	const connectionSubscribers = new Set<ConnectionSubscriber>();

	return {
		v2TransportAdapter: {
			connect: vi.fn(),
			disconnect: vi.fn(),
			send: vi.fn(),
			reconnect: vi.fn(),
			subscribe: vi.fn((callback: Subscriber) => {
				subscribers.add(callback);
				return () => subscribers.delete(callback);
			}),
			subscribeConnection: vi.fn((callback: ConnectionSubscriber) => {
				connectionSubscribers.add(callback);
				callback({
					status: "connected",
					mode: "websocket",
					reconnectAttempts: 0,
					lastError: null,
				});
				return () => connectionSubscribers.delete(callback);
			}),
			__simulateIncoming: (message: unknown) => {
				for (const subscriber of subscribers) {
					subscriber(message);
				}
			},
		},
	};
});

const initialStoreState = useWorkspaceStore.getState();

function createTestQueryClient() {
	return new QueryClient({
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
}

function renderWorkspace(options?: { isSettingsOpen?: boolean }) {
	const queryClient = createTestQueryClient();

	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[options?.isSettingsOpen ? "/v2/settings" : "/v2"]}>
				<V2Workspace isSettingsOpen={options?.isSettingsOpen} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("V2 Frontend Integration", () => {
	let sessionsFixture: Array<{
		id: string;
		title: string | null;
		updated_at: string;
		message_count: number;
		preview?: string | null;
	}>;
	let sessionMessagesFixture: Record<string, unknown[]>;
	let setupModelsFixture: {
		models: Array<{
			id: string;
			display_name: string;
			role: string;
			file_size: number;
			filename?: string;
			source: string;
			loader?: string;
			repo_id?: string | null;
			revision?: string | null;
			sha256?: string | null;
			is_active?: boolean;
		}>;
	};
	let progressResponses: Array<{
		status: string;
		progress: number;
		message: string;
	}>;

	beforeEach(() => {
		vi.clearAllMocks();
		useWorkspaceStore.setState(initialStoreState, true);

		sessionsFixture = [
			{
				id: "test-session-1",
				title: "Test Session",
				updated_at: "2026-03-17T00:00:00.000Z",
				message_count: 0,
				preview: null,
			},
			{
				id: "test-session-2",
				title: "Older Session",
				updated_at: "2026-03-16T00:00:00.000Z",
				message_count: 3,
				preview: "Older preview",
			},
		];
		sessionMessagesFixture = {
			"test-session-1": [],
			"test-session-2": [],
			"created-session": [],
		};
		setupModelsFixture = {
			models: [
				{
					id: "model-text-1",
					display_name: "Text Model",
					role: "text",
					file_size: 1024 * 1024 * 128,
					filename: "text.gguf",
					source: "owner/text-model",
					loader: "llama_cpp",
					repo_id: "owner/text-model",
					revision: "main",
					sha256: "a".repeat(64),
					is_active: true,
				},
				{
					id: "model-embed-1",
					display_name: "Embedding Model",
					role: "embedding",
					file_size: 1024 * 1024 * 64,
					filename: "embed.gguf",
					source: "owner/embed-model",
					loader: "llama_cpp",
					repo_id: "owner/embed-model",
					revision: "main",
					sha256: "b".repeat(64),
				},
			],
		};
		progressResponses = [
			{
				status: "downloading",
				progress: 0.4,
				message: "Downloading model...",
			},
			{
				status: "completed",
				progress: 1,
				message: "Download completed!",
			},
		];

		(v2ApiClient.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			async (url: string) => {
				if (url === "/api/config") {
					return {
						app: {
							language: "ja",
							setup_completed: true,
							max_input_length: 4000,
							nsfw_enabled: false,
							tool_execution_timeout: 120000,
							graph_execution_timeout: 180000,
						},
						active_agent_profile: "default",
						tools: {
							search_provider: "duckduckgo",
						},
						privacy: {
							allow_web_search: true,
							redact_pii: true,
						},
						thinking: {
							chat_default: false,
							search_default: false,
						},
						features: {
							redesign: {
								frontend_logging: false,
								transport_mode: "websocket",
							},
						},
					};
				}

				if (url.includes("/api/sessions/") && url.includes("/messages")) {
					const sessionId =
						url.match(/\/api\/sessions\/([^/]+)\/messages/)?.[1] ?? "unknown";
					return { messages: sessionMessagesFixture[sessionId] ?? [] };
				}

				if (url === "/api/sessions") {
					return { sessions: sessionsFixture };
				}

				if (url === "/api/setup/models") {
					return setupModelsFixture;
				}

				if (url.startsWith("/api/setup/model/update-check")) {
					return {
						update_available: true,
						reason: "sha256_mismatch",
						current_revision: "main",
						latest_revision: "new-revision",
						current_sha256: "a".repeat(64),
						latest_sha256: "c".repeat(64),
					};
				}

				if (url === "/api/setup/progress") {
					return progressResponses.length > 1
						? progressResponses.shift()
						: progressResponses[0];
				}

				if (url === "/api/setup/binary/update-info") {
					return {
						has_update: true,
						current_version: "b1000",
						latest_version: "b1001",
						release_notes: "Bug fixes",
					};
				}

				return {};
			},
		);

		(v2ApiClient.post as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			async (url: string, _schema: unknown, body?: unknown) => {
				if (url === "/api/sessions") {
					const createdSession = {
						id: "created-session",
						title: null,
						updated_at: "2026-03-17T01:00:00.000Z",
						message_count: 0,
						preview: null,
					};
					sessionsFixture = [createdSession, ...sessionsFixture];
					return { session: createdSession };
				}

				if (url === "/api/setup/model/download") {
					const payload = body as { acknowledge_warnings?: boolean } | undefined;
					if (payload?.acknowledge_warnings === false) {
						const consentPayload = consentRequiredErrorResponseSchema.parse({
							error: "Download requires confirmation",
							requires_consent: true,
							warnings: ["Owner is outside the allowlist"],
						});
						throw new V2ApiError(
							"Download requires confirmation",
							409,
							consentPayload,
						);
					}

					return { success: true, job_id: "job-download-1" };
				}

				if (url === "/api/setup/binary/update") {
					return { success: true, job_id: "job-binary-1" };
				}

				return {};
			},
		);

		(v2ApiClient.patch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
		(v2ApiClient.delete as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
	});

	it("loads sessions, sends a message, and renders the streamed response", async () => {
		renderWorkspace();

		expect(await screen.findByText("Test Session")).toBeInTheDocument();
		await waitFor(() => {
			expect(v2TransportAdapter.send).toHaveBeenCalledWith({
				type: "set_session",
				sessionId: "test-session-1",
			});
		});
		vi.mocked(v2TransportAdapter.send).mockClear();

		const input = screen.getByPlaceholderText("Type here...");
		fireEvent.change(input, { target: { value: "Hello Tepora!" } });
		fireEvent.keyDown(input, {
			key: "Enter",
			code: "Enter",
			shiftKey: false,
		});

		await waitFor(() => {
			expect(v2TransportAdapter.send).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Hello Tepora!",
					mode: "chat",
				}),
			);
		});

		const transportMock = v2TransportAdapter as unknown as {
			__simulateIncoming: (message: unknown) => void;
		};

		act(() => {
			sessionMessagesFixture["test-session-1"] = [
				{
					id: "history-user-1",
					role: "user",
					content: "Hello Tepora!",
					timestamp: "2026-03-17T00:00:00.500Z",
					mode: "chat",
				},
				{
					id: "history-assistant-1",
					role: "assistant",
					content: "Hi there, I am Tepora V2.",
					timestamp: "2026-03-17T00:00:03.000Z",
					mode: "chat",
				},
			];
			transportMock.__simulateIncoming({
				type: "chunk",
				eventId: "event-1",
				streamId: "stream-1",
				seq: 1,
				emittedAt: "2026-03-17T00:00:01.000Z",
				message: "Hi there, ",
			});
			transportMock.__simulateIncoming({
				type: "chunk",
				eventId: "event-2",
				streamId: "stream-1",
				seq: 2,
				emittedAt: "2026-03-17T00:00:02.000Z",
				message: "I am Tepora V2.",
			});
			transportMock.__simulateIncoming({
				type: "done",
				eventId: "event-3",
				streamId: "stream-1",
				seq: 3,
				emittedAt: "2026-03-17T00:00:03.000Z",
			});
			transportMock.__simulateIncoming({
				type: "interaction_complete",
				eventId: "event-4",
				streamId: "stream-1",
				seq: 4,
				emittedAt: "2026-03-17T00:00:03.500Z",
				sessionId: "test-session-1",
			});
		});

		await waitFor(() => {
			expect(screen.getByText("Hi there, I am Tepora V2.")).toBeInTheDocument();
		});
	});

	it("creates a new session and switches the active session", async () => {
		renderWorkspace();

		expect(await screen.findByText("Test Session")).toBeInTheDocument();

		vi.mocked(v2TransportAdapter.send).mockClear();
		fireEvent.click(screen.getByRole("button", { name: "New Session" }));

		await waitFor(() => {
			expect(v2ApiClient.post).toHaveBeenCalled();
		});
		const postPayload = (
			(v2ApiClient.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ??
			[]
		)[2];
		expect(postPayload).toEqual({ title: null });

		await waitFor(() => {
			expect(screen.getByText("Untitled session")).toBeInTheDocument();
		});

		await waitFor(() => {
			expect(v2TransportAdapter.send).toHaveBeenCalledWith({
				type: "set_session",
				sessionId: "created-session",
			});
		});
	});

	it("edits and saves settings through the integrated settings screen", async () => {
		renderWorkspace({ isSettingsOpen: true });

		expect(
			await screen.findByText(
				"Core session and language defaults used across v2 screens.",
			),
		).toBeInTheDocument();

		const languageSelect = screen.getAllByRole("combobox")[0];
		fireEvent.change(languageSelect, { target: { value: "en" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect(v2ApiClient.patch).toHaveBeenCalled();
		});

		const patchPayload = (
			(v2ApiClient.patch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ??
			[]
		)[2];
		expect(patchPayload).toEqual({
			app: {
				language: "en",
			},
		});
	});

	it("shows tool confirmation in the agent panel and sends the decision", async () => {
		renderWorkspace();

		expect(await screen.findByText("Test Session")).toBeInTheDocument();

		const transportMock = v2TransportAdapter as unknown as {
			__simulateIncoming: (message: unknown) => void;
		};

		act(() => {
			transportMock.__simulateIncoming({
				type: "tool_confirmation_request",
				eventId: "tool-event-1",
				streamId: "tool-stream-1",
				seq: 1,
				emittedAt: "2026-03-17T00:00:04.000Z",
				data: {
					requestId: "tool-request-1",
					toolName: "web.search",
					toolArgs: { query: "Tepora" },
					scope: "native_tool",
					scopeName: "web.search",
					riskLevel: "medium",
					expiryOptions: [300],
				},
			});
		});

		expect(await screen.findByText("Approval Required")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Approve once" }));

		await waitFor(() => {
			expect(v2TransportAdapter.send).toHaveBeenCalledWith({
				type: "tool_confirmation_response",
				requestId: "tool-request-1",
				decision: "once",
				ttlSeconds: undefined,
			});
		});
	});

	it("renders the models section, checks updates, and completes a confirmed download", async () => {
		renderWorkspace({ isSettingsOpen: true });

		expect(
			await screen.findByText(
				"Core session and language defaults used across v2 screens.",
			),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Models" }));

		expect(
			await screen.findByRole("heading", { name: "Download Model" }),
		).toBeInTheDocument();
		expect(await screen.findByText("Text Model")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Check Updates" }));

		await waitFor(() => {
			expect(screen.getByText("Update available")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole("button", { name: "Update" }));

		await waitFor(() => {
			expect(screen.getByText("Confirm Download")).toBeInTheDocument();
			expect(screen.getByText("Owner is outside the allowlist")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole("button", { name: "Proceed" }));

		await waitFor(() => {
			expect(screen.getByText("Download completed!")).toBeInTheDocument();
		});

		expect(v2ApiClient.post).toHaveBeenCalledWith(
			"/api/setup/model/download",
			expect.anything(),
			expect.objectContaining({
				repo_id: "owner/text-model",
				filename: "text.gguf",
				acknowledge_warnings: true,
			}),
		);
	});

	it("includes safe attachments in the send payload", async () => {
		const view = renderWorkspace();

		expect(await screen.findByText("Test Session")).toBeInTheDocument();
		await waitFor(() => {
			expect(v2TransportAdapter.send).toHaveBeenCalledWith({
				type: "set_session",
				sessionId: "test-session-1",
			});
		});
		vi.mocked(v2TransportAdapter.send).mockClear();

		const fileInput = view.container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement | null;
		expect(fileInput).not.toBeNull();

		const safeFile = new File(["safe attachment body"], "context.txt", {
			type: "text/plain",
		});
		fireEvent.change(fileInput!, {
			target: {
				files: [safeFile],
			},
		});

		await waitFor(() => {
			expect(screen.getByText("context.txt")).toBeInTheDocument();
		});

		const input = screen.getByPlaceholderText("Type here...");
		fireEvent.change(input, { target: { value: "Use the attachment" } });
		fireEvent.keyDown(input, {
			key: "Enter",
			code: "Enter",
			shiftKey: false,
		});

		await waitFor(() => {
			expect(v2TransportAdapter.send).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Use the attachment",
					attachments: [
						expect.objectContaining({
							name: "context.txt",
							content: "safe attachment body",
							type: "text/plain",
						}),
					],
				}),
			);
		});
	});

	it("blocks attachments that contain pii and shows an error", async () => {
		const view = renderWorkspace();

		expect(await screen.findByText("Test Session")).toBeInTheDocument();

		const fileInput = view.container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement | null;
		expect(fileInput).not.toBeNull();

		const blockedFile = new File(
			["reach me at test@example.com"],
			"secret.txt",
			{ type: "text/plain" },
		);
		fireEvent.change(fileInput!, {
			target: {
				files: [blockedFile],
			},
		});

		await waitFor(() => {
			expect(
				screen.getByText(/Attachment blocked by PII detection: secret\.txt/),
			).toBeInTheDocument();
		});

		expect(screen.queryByText("secret.txt")).not.toBeInTheDocument();
	});
});
