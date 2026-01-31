import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as useModelUpdateCheckHook from "../../../../../hooks/useModelUpdateCheck";
import { ModelListOverlay } from "../ModelListOverlay";

// Mock the hook
vi.mock("../../../../../hooks/useModelUpdateCheck", () => ({
	useModelUpdateCheck: vi.fn(),
}));

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const map: Record<string, string> = {
				"settings.sections.models.check_updates": "Check Updates",
				"settings.sections.models.checking": "Checking...",
				"settings.sections.models.update_available": "Update Available",
				"settings.sections.models.up_to_date": "Up to date",
				"settings.sections.models.check_failed": "Check Failed",
				"settings.sections.models.update_btn": "Update Model",
			};
			return map[key] || key;
		},
	}),
}));

// Mock API
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

describe("ModelListOverlay", () => {
	const mockOnClose = vi.fn();
	const mockOnDelete = vi.fn();
	const mockOnReorder = vi.fn();

	const mockModels = [
		{
			id: "model-1",
			display_name: "Test Model 1",
			role: "text",
			file_size: 1024 * 1024 * 100, // 100MB
			filename: "model1.gguf",
			source: "repo/model1",
		},
		{
			id: "model-2",
			display_name: "Test Model 2",
			role: "text",
			file_size: 1024 * 1024 * 200, // 200MB
			filename: "model2.gguf",
			source: "repo/model2",
		},
	];

	const defaultHookValues = {
		updateStatus: {},
		isChecking: false,
		checkAllModels: vi.fn(),
		checkUpdate: vi.fn(),
	};

	beforeEach(() => {
		vi.resetAllMocks();
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({}),
		});
		(
			useModelUpdateCheckHook.useModelUpdateCheck as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue(defaultHookValues);
	});

	it("renders model list correctly", () => {
		render(
			<ModelListOverlay
				isOpen={true}
				onClose={mockOnClose}
				models={mockModels}
				onDelete={mockOnDelete}
				onReorder={mockOnReorder}
			/>,
		);

		expect(screen.getByText("Test Model 1")).toBeInTheDocument();
		expect(screen.getByText("Test Model 2")).toBeInTheDocument();
		expect(screen.getByText("Check Updates")).toBeInTheDocument();
	});

	it("triggers checkAllModels when Check Updates is clicked", async () => {
		const checkAllModelsMock = vi.fn();
		(
			useModelUpdateCheckHook.useModelUpdateCheck as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue({
			...defaultHookValues,
			checkAllModels: checkAllModelsMock,
		});

		render(
			<ModelListOverlay
				isOpen={true}
				onClose={mockOnClose}
				models={mockModels}
				onDelete={mockOnDelete}
				onReorder={mockOnReorder}
			/>,
		);

		const checkButton = screen.getByText("Check Updates");
		fireEvent.click(checkButton);

		expect(checkAllModelsMock).toHaveBeenCalledWith(["model-1", "model-2"]);
	});

	it("displays 'Update Available' badge when update is available", () => {
		(
			useModelUpdateCheckHook.useModelUpdateCheck as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue({
			...defaultHookValues,
			updateStatus: {
				"model-1": {
					update_available: true,
					reason: "revision_mismatch",
				},
			},
		});

		render(
			<ModelListOverlay
				isOpen={true}
				onClose={mockOnClose}
				models={mockModels}
				onDelete={mockOnDelete}
				onReorder={mockOnReorder}
			/>,
		);

		expect(screen.getByText("Update Available")).toBeInTheDocument();
		// Should show update button (download icon inside button)
		expect(screen.getByTitle("Update Model")).toBeInTheDocument();
	});

	it("displays 'Up to date' when model is up to date", () => {
		(
			useModelUpdateCheckHook.useModelUpdateCheck as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue({
			...defaultHookValues,
			updateStatus: {
				"model-1": {
					update_available: false,
					reason: "up_to_date",
				},
			},
		});

		render(
			<ModelListOverlay
				isOpen={true}
				onClose={mockOnClose}
				models={mockModels}
				onDelete={mockOnDelete}
				onReorder={mockOnReorder}
			/>,
		);

		expect(screen.getByText("Up to date")).toBeInTheDocument();
	});

	it("calls download API when Update button is clicked", async () => {
		(
			useModelUpdateCheckHook.useModelUpdateCheck as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue({
			...defaultHookValues,
			updateStatus: {
				"model-1": {
					update_available: true,
					reason: "revision_mismatch",
				},
			},
		});

		render(
			<ModelListOverlay
				isOpen={true}
				onClose={mockOnClose}
				models={mockModels}
				onDelete={mockOnDelete}
				onReorder={mockOnReorder}
			/>,
		);

		const updateButton = screen.getByTitle("Update Model");
		fireEvent.click(updateButton);

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/setup/model/download"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("repo/model1"),
			}),
		);
	});
});
