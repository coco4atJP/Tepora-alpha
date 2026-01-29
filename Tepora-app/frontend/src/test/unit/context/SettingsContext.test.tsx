import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsProvider } from "../../../context/SettingsContext";
import { useSettings } from "../../../hooks/useSettings";

// Mock Config Data
const mockConfig = {
	app: {
		max_input_length: 1000,
		graph_recursion_limit: 10,
		tool_execution_timeout: 30,
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
	},
	chat_history: {
		max_tokens: 2000,
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
	professionals: {},
	active_agent_profile: "default",
	tools: {},
};

describe("SettingsContext", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fetches config on mount", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => mockConfig,
		} as Response);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<SettingsProvider>{children}</SettingsProvider>
			</QueryClientProvider>
		);

		const { result } = renderHook(() => useSettings(), { wrapper });

		// Initially loading
		expect(result.current.loading).toBe(true);
		expect(result.current.config).toBeNull();

		// Wait for load
		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.config).toEqual(mockConfig);
		expect(result.current.error).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("handles fetch error", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 500,
		} as Response);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<SettingsProvider>{children}</SettingsProvider>
			</QueryClientProvider>
		);

		const { result } = renderHook(() => useSettings(), { wrapper });

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.config).toBeNull();
		expect(result.current.error).toBeTruthy();
	});

	it("updates app settings", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => mockConfig,
		} as Response);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<SettingsProvider>{children}</SettingsProvider>
			</QueryClientProvider>
		);

		const { result } = renderHook(() => useSettings(), { wrapper });

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		act(() => {
			result.current.updateApp("max_input_length", 2000);
		});

		expect(result.current.config?.app.max_input_length).toBe(2000);
		expect(result.current.hasChanges).toBe(true);
	});

	it("saves config", async () => {
		// Mock initial fetch
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => mockConfig,
		} as Response);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<SettingsProvider>{children}</SettingsProvider>
			</QueryClientProvider>
		);

		const { result } = renderHook(() => useSettings(), { wrapper });

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		// Mock save call (second fetch call)
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ success: true }),
		} as Response);

		await act(async () => {
			const success = await result.current.saveConfig();
			expect(success).toBe(true);
		});

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenLastCalledWith(
			expect.stringContaining("/api/config"),
			expect.objectContaining({
				method: "POST",
				body: expect.any(String),
			}),
		);
	});

	it("adds a character", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => mockConfig,
		} as Response);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<SettingsProvider>{children}</SettingsProvider>
			</QueryClientProvider>
		);

		const { result } = renderHook(() => useSettings(), { wrapper });

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		act(() => {
			result.current.addCharacter("new_char");
		});

		expect(result.current.config?.characters.new_char).toBeDefined();
		expect(result.current.config?.characters.new_char.name).toBe("new_char");
	});

	it("deletes a character", async () => {
		const configWithChar = {
			...mockConfig,
			characters: {
				char1: { name: "Char 1", system_prompt: "" },
			},
		};

		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => configWithChar,
		} as Response);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				<SettingsProvider>{children}</SettingsProvider>
			</QueryClientProvider>
		);

		const { result } = renderHook(() => useSettings(), { wrapper });

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		act(() => {
			result.current.deleteCharacter("char1");
		});

		expect(result.current.config?.characters.char1).toBeUndefined();
	});
});
