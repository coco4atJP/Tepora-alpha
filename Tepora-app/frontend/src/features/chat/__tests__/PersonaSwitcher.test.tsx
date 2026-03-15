import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../../../test/test-utils";

import PersonaSwitcher from "../PersonaSwitcher";

const profileActions = {
	setActiveAgent: vi.fn(),
	updateCharacter: vi.fn(),
	addCharacter: vi.fn(),
	deleteCharacter: vi.fn(),
	activeAgentProfile: "default",
};

const saveConfig = vi.fn().mockResolvedValue(true);

vi.mock("../../../context/SettingsContext", () => ({
	useSettingsState: () => ({
		config: {
			app: {
				max_input_length: 4096,
				graph_recursion_limit: 10,
				tool_execution_timeout: 30,
				tool_approval_timeout: 300,
				graph_execution_timeout: 60,
				web_fetch_max_chars: 6000,
				web_fetch_max_bytes: 1000000,
				web_fetch_timeout_secs: 10,
				dangerous_patterns: [],
				language: "ja",
				nsfw_enabled: false,
				mcp_config_path: "",
			},
			llm_manager: {
				process_terminate_timeout: 5,
				health_check_timeout: 10,
				health_check_interval: 30,
				tokenizer_model_key: "default",
				cache_size: 1,
			},
			chat_history: {
				max_tokens: 4096,
				default_limit: 50,
			},
			em_llm: {
				surprise_gamma: 0.5,
				min_event_size: 10,
				max_event_size: 100,
				total_retrieved_events: 5,
				repr_topk: 3,
				use_boundary_refinement: true,
			},
			models_gguf: {
				text_model: { path: "model.gguf", port: 8000, n_ctx: 4096, n_gpu_layers: 0 },
				embedding_model: { path: "embed.gguf", port: 8001, n_ctx: 512, n_gpu_layers: 0 },
			},
			characters: {
				default: {
					name: "Tepora",
					description: "Default assistant",
					system_prompt: "You are Tepora.",
				},
				casual: {
					name: "Barista",
					description: "Casual assistant",
					system_prompt: "You are a friendly barista.",
				},
			},
			active_agent_profile: profileActions.activeAgentProfile,
			tools: {},
			privacy: { allow_web_search: false, redact_pii: true },
		},
		originalConfig: null,
		loading: false,
		error: null,
		hasChanges: false,
		saving: false,
	}),
	useAgentProfiles: () => profileActions,
	useSettingsConfigActions: () => ({
		saveConfig,
	}),
}));

describe("PersonaSwitcher", () => {
	it("renders correctly", () => {
		render(<PersonaSwitcher />);
		expect(screen.getByTitle("Switch Persona")).toBeInTheDocument();
	});

	it("opens menu on click", () => {
		render(<PersonaSwitcher />);
		fireEvent.click(screen.getByTitle("Switch Persona"));
		expect(screen.getByText("Tepora")).toBeInTheDocument();
		expect(screen.getByText("Barista")).toBeInTheDocument();
	});

	it("calls setActiveAgent when a persona is selected", async () => {
		render(<PersonaSwitcher />);
		await act(async () => {
			fireEvent.click(screen.getByTitle("Switch Persona"));
			fireEvent.click(screen.getByText("Barista"));
		});
		expect(profileActions.setActiveAgent).toHaveBeenCalledWith("casual");
	});
});
