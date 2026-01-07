import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CharacterSettings from "../../../components/settings/sections/CharacterSettings";

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
	Briefcase: () => <span data-testid="icon-briefcase" />,
}));

vi.mock("../../../hooks/useSettings", () => ({
	useSettings: () => ({
		config: {
			app: { nsfw_enabled: false },
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

	it("renders character profiles", () => {
		render(<CharacterSettings {...mockProps} />);
		expect(screen.getByText("Default Agent")).toBeInTheDocument();
		expect(screen.getByText("Custom Agent")).toBeInTheDocument();
	});

	it("highlights active profile", () => {
		render(<CharacterSettings {...mockProps} />);
		// Active profile usually has a visual indicator, check for check icon or class
		// In mock implementation, check icon is rendered only for active
		const checkIcons = screen.getAllByTestId("icon-check");
		expect(checkIcons.length).toBe(1);
	});

	it("opens add modal when clicking add button", () => {
		render(<CharacterSettings {...mockProps} />);

		const addButton = screen.getByTestId("icon-plus").closest("button");
		expect(addButton).toBeInTheDocument();
		fireEvent.click(addButton!);

		// Check for modal title or content
		// Title uses translation key: settings.sections.agents.modal.title_add
		expect(
			screen.getByText("settings.sections.agents.modal.title_add"),
		).toBeInTheDocument();
	});

	it("validates new character key", async () => {
		render(<CharacterSettings {...mockProps} />);

		// Open add modal
		const addButton = screen.getByTestId("icon-plus").closest("button");
		fireEvent.click(addButton!);

		// Find save button
		const saveButton = screen.getByText("common.save").closest("button");

		// Click save without key
		fireEvent.click(saveButton!);

		// Expect error message
		expect(
			screen.getByText("settings.sections.agents.error_empty_key"),
		).toBeInTheDocument();
		expect(mockProps.onAddProfile).not.toHaveBeenCalled();
	});

	it("calls update on valid addition", async () => {
		render(<CharacterSettings {...mockProps} />);

		// Open add modal
		const addButton = screen.getByTestId("icon-plus").closest("button");
		fireEvent.click(addButton!);

		// Fill key input
		// We need to find the correct input. Based on code it might be the one with placeholder or label
		// Or since it's the first input in the modal for key (if it's new)
		const inputs = screen.getAllByRole("textbox");
		// Assuming first one is key for new entry
		const keyInput = inputs[0];
		fireEvent.change(keyInput, { target: { value: "new_hero" } });

		// Fill name (optional but good)
		// ...

		// Find save button
		const saveButton = screen.getByText("common.save").closest("button");
		fireEvent.click(saveButton!);

		expect(mockProps.onAddProfile).toHaveBeenCalledWith("new_hero");
		// update is also called immediately in the component logic
		expect(mockProps.onUpdateProfile).toHaveBeenCalled();
	});
});
