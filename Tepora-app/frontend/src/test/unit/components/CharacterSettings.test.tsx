import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CharacterSettings from "../../../features/settings/components/sections/CharacterSettings";

vi.mock("lucide-react", () => ({
	Users: () => <span data-testid="icon-users" />,
	Check: () => <span data-testid="icon-check" />,
	Edit2: () => <span data-testid="icon-edit" />,
	Trash2: () => <span data-testid="icon-trash" />,
	Plus: () => <span data-testid="icon-plus" />,
	AlertCircle: () => <span data-testid="icon-alert" />,
	X: () => <span data-testid="icon-close" />,
	Save: () => <span data-testid="icon-save" />,
	Bot: () => <span data-testid="icon-bot" />,
	User: () => <span data-testid="icon-user" />,
	Smile: () => <span data-testid="icon-smile" />,
	Image: () => <span data-testid="icon-image" />,
	ChevronDown: () => <span data-testid="icon-chevron-down" />,
	ChevronRight: () => <span data-testid="icon-chevron-right" />,
	HelpCircle: () => <span data-testid="icon-help-circle" />,
	Cpu: () => <span data-testid="icon-cpu" />,
	FolderOpen: () => <span data-testid="icon-folder-open" />,
}));

vi.mock("../../../context/SettingsContext", () => ({
	useSettingsState: () => ({
		config: {
			app: { nsfw_enabled: false },
			models_gguf: {
				text_model: {
					path: "test.gguf",
					port: 8080,
					n_ctx: 2048,
					n_gpu_layers: -1,
				},
			},
		},
	}),
	useSettingsConfigActions: () => ({
		updateApp: vi.fn(),
	}),
}));

describe("CharacterSettings", () => {
	const mockProps = {
		profiles: {
			default: {
				name: "Default Agent",
				description: "",
				system_prompt: "You are helpful.",
			},
			custom: {
				name: "Custom Agent",
				description: "",
				system_prompt: "Custom prompt.",
			},
		},
		activeProfileId: "default",
		onUpdateProfile: vi.fn(),
		onSetActive: vi.fn(),
		onAddProfile: vi.fn(),
		onDeleteProfile: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders character profiles", () => {
		render(<CharacterSettings {...mockProps} />);
		expect(screen.getByText("Default Agent")).toBeInTheDocument();
		expect(screen.getByText("Custom Agent")).toBeInTheDocument();
	});

	it("opens add modal and validates new key", async () => {
		render(<CharacterSettings {...mockProps} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /settings\.sections\.agents\.add_new_profile|add new profile/i,
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: /common\.save|save/i,
			}),
		);
		expect(
			await screen.findByText(/settings\.sections\.agents\.error_empty_key|key cannot be empty/i),
		).toBeInTheDocument();
	});

	it("calls update on valid addition", async () => {
		render(<CharacterSettings {...mockProps} />);
		fireEvent.click(
			screen.getByRole("button", {
				name: /settings\.sections\.agents\.add_new_profile|add new profile/i,
			}),
		);
		fireEvent.change(
			await screen.findByPlaceholderText(
				/settings\.sections\.agents\.modal\.key_placeholder|coding_expert/i,
			),
			{ target: { value: "new_hero" } },
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: /common\.save|save/i,
			}),
		);
		await waitFor(() => {
			expect(mockProps.onAddProfile).toHaveBeenCalledWith("new_hero");
			expect(mockProps.onUpdateProfile).toHaveBeenCalled();
		});
	});
});
