import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CharacterSettings from "../../../features/settings/components/sections/CharacterSettings";

// Mock Lucide icons to avoid rendering issues
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

vi.mock("../../../hooks/useSettings", () => ({
	useSettings: () => ({
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

	it("highlights active profile", () => {
		render(<CharacterSettings {...mockProps} />);
		const checkIcons = screen.getAllByTestId("icon-check");
		expect(checkIcons.length).toBe(1);
	});

	it("opens add modal when clicking add button", async () => {
		render(<CharacterSettings {...mockProps} />);

		const addButton = screen.getByRole("button", {
			name: /settings\.sections\.agents\.add_new_profile|add new profile/i,
		});
		fireEvent.click(addButton);

		expect(
			await screen.findByText(/settings\.sections\.agents\.modal\.title_add|add character/i),
		).toBeInTheDocument();
	});

	it("validates new character key", async () => {
		render(<CharacterSettings {...mockProps} />);

		const addButton = screen.getByRole("button", {
			name: /settings\.sections\.agents\.add_new_profile|add new profile/i,
		});
		fireEvent.click(addButton);

		const saveButton = await screen.findByRole("button", {
			name: /common\.save|save/i,
		});
		fireEvent.click(saveButton);

		expect(
			await screen.findByText(/settings\.sections\.agents\.error_empty_key|key cannot be empty/i),
		).toBeInTheDocument();
		expect(mockProps.onAddProfile).not.toHaveBeenCalled();
	});

	it("calls update on valid addition", async () => {
		render(<CharacterSettings {...mockProps} />);

		const addButton = screen.getByRole("button", {
			name: /settings\.sections\.agents\.add_new_profile|add new profile/i,
		});
		fireEvent.click(addButton);

		const keyInput = await screen.findByPlaceholderText(
			/settings\.sections\.agents\.modal\.key_placeholder|coding_expert/i,
		);
		fireEvent.change(keyInput, { target: { value: "new_hero" } });

		const saveButton = await screen.findByRole("button", {
			name: /common\.save|save/i,
		});
		fireEvent.click(saveButton);

		await waitFor(() => {
			expect(mockProps.onAddProfile).toHaveBeenCalledWith("new_hero");
			expect(mockProps.onUpdateProfile).toHaveBeenCalled();
		});
	});
});