import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SettingsProvider,
	useAgentProfiles,
	useAgentSkills,
	useSettingsConfigActions,
	useSettingsState,
} from "../../../context/SettingsContext";

const mockConfig = {
	app: {
		max_input_length: 1000,
		graph_recursion_limit: 10,
		tool_execution_timeout: 30,
		tool_approval_timeout: 300,
		graph_execution_timeout: 60,
		web_fetch_max_chars: 6000,
		web_fetch_max_bytes: 1000000,
		web_fetch_timeout_secs: 10,
		dangerous_patterns: [],
		language: "en",
		nsfw_enabled: false,
		mcp_config_path: "config.json",
	},
	llm_manager: {
		process_terminate_timeout: 5,
		health_check_timeout: 5,
		health_check_interval: 60,
		tokenizer_model_key: "default",
		cache_size: 1,
	},
	chat_history: {
		max_tokens: 2000,
		default_limit: 50,
	},
	em_llm: {
		surprise_gamma: 0.1,
		min_event_size: 10,
		max_event_size: 100,
		total_retrieved_events: 5,
		repr_topk: 3,
		use_boundary_refinement: true,
	},
	models_gguf: {
		text_model: {
			path: "model.gguf",
			port: 8080,
			n_ctx: 2048,
			n_gpu_layers: 0,
		},
		embedding_model: {
			path: "embed.gguf",
			port: 8081,
			n_ctx: 512,
			n_gpu_layers: 0,
		},
	},
	characters: {},
	active_agent_profile: "default",
	tools: {},
	privacy: {
		allow_web_search: false,
		redact_pii: true,
	},
};

describe("SettingsContext", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const createWrapper = () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		return ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<SettingsProvider>{children}</SettingsProvider>
			</QueryClientProvider>
		);
	};

	it("loads config and agent skills on mount", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => mockConfig,
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ skills: [], roots: [] }),
			} as Response);

		const { result } = renderHook(
			() => ({
				state: useSettingsState(),
				skills: useAgentSkills(),
			}),
			{ wrapper: createWrapper() },
		);

		expect(result.current.state.loading).toBe(true);

		await waitFor(() => {
			expect(result.current.state.loading).toBe(false);
		});

		expect(result.current.state.config).toEqual(mockConfig);
		expect(result.current.skills.agentSkills).toEqual({});
	});

	it("updates config through settings actions", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => mockConfig,
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ skills: [], roots: [] }),
			} as Response);

		const { result } = renderHook(
			() => ({
				state: useSettingsState(),
				actions: useSettingsConfigActions(),
			}),
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(result.current.state.loading).toBe(false);
		});

		act(() => {
			result.current.actions.updateApp("max_input_length", 2000);
		});

		expect(result.current.state.config?.app.max_input_length).toBe(2000);
		expect(result.current.state.hasChanges).toBe(true);
	});

	it("adds a character through agent profile actions", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => mockConfig,
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ skills: [], roots: [] }),
			} as Response);

		const { result } = renderHook(
			() => ({
				state: useSettingsState(),
				profiles: useAgentProfiles(),
			}),
			{ wrapper: createWrapper() },
		);

		await waitFor(() => {
			expect(result.current.state.loading).toBe(false);
		});

		act(() => {
			result.current.profiles.addCharacter("new_character");
		});

		expect(result.current.state.config?.characters.new_character).toBeDefined();
	});
});
