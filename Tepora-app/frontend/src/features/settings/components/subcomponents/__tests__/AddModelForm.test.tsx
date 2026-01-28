import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddModelForm } from "../AddModelForm";

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const map: Record<string, string> = {
				"settings.sections.models.add_modal.title": "Add Model",
				"settings.sections.models.add_modal.check": "Check",
				"settings.sections.models.add_modal.download": "Download Model",
				"settings.sections.models.consent_dialog.title": "Confirm Download",
				"settings.sections.models.consent_dialog.description":
					"Confirmation required",
				"settings.sections.models.consent_dialog.confirm": "Proceed",
				"settings.sections.models.add_modal.repo_id_placeholder": "user/repo",
				"settings.sections.models.add_modal.filename_placeholder":
					"model-Q4_K_M.gguf",
				"common.cancel": "Cancel",
			};
			return map[key] || key;
		},
	}),
}));

// Mock API utils
vi.mock("../../../../utils/api-client", () => ({
	apiClient: {
		get: vi.fn(),
		post: vi.fn(),
		delete: vi.fn(),
	},
	ApiError: class extends Error {
		status: number;
		data: any;
		constructor(status: number, data: any) {
			super("ApiError");
			this.status = status;
			this.data = data;
		}
	},
}));

// Mock fetch
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// Mock Tauri Dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

describe("AddModelForm", () => {
	const mockOnModelAdded = vi.fn();

	beforeEach(() => {
		vi.resetAllMocks();
		mockOnModelAdded.mockClear();
		// Default Implementation
		fetchMock.mockImplementation(async (url) => {
			// Safe string conversion
			const u = String(url);
			if (u.includes("check")) {
				return {
					ok: true,
					json: async () => ({ exists: true, size: 100 }),
				};
			}
			return { ok: false, status: 404 };
		});
	});

	const expandForm = async () => {
		const toggleButton = screen.getByText("Add Model");
		fireEvent.click(toggleButton);
		await screen.findByPlaceholderText("user/repo");
	};

	it("triggers normal download when no warning", async () => {
		render(<AddModelForm onModelAdded={mockOnModelAdded} />);

		await expandForm();
		const repoInput = screen.getByPlaceholderText("user/repo");
		const fileInput = screen.getByPlaceholderText("model-Q4_K_M.gguf");

		fireEvent.change(repoInput, { target: { value: "valid/repo" } });
		fireEvent.change(fileInput, { target: { value: "valid.gguf" } });

		const downloadBtn = screen.getByText("Download Model");
		await waitFor(() => expect(downloadBtn).not.toBeDisabled(), {
			timeout: 3000,
		});

		// Setup Download Mock
		fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("check"))
				return { ok: true, json: async () => ({ exists: true }) };
			if (u.includes("download")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ success: true }),
				};
			}
			return { ok: false };
		});

		fireEvent.click(downloadBtn);

		// Verify API call
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("download"),
				expect.objectContaining({
					method: "POST",
					body: expect.stringContaining('"acknowledge_warnings":false'),
				}),
			);
		});
	});

	it("shows consent dialog on 409 response", async () => {
		render(<AddModelForm onModelAdded={mockOnModelAdded} />);

		await expandForm();
		const repoInput = screen.getByPlaceholderText("user/repo");
		const fileInput = screen.getByPlaceholderText("model-Q4_K_M.gguf");

		fireEvent.change(repoInput, { target: { value: "warn/repo" } });
		fireEvent.change(fileInput, { target: { value: "warn.gguf" } });

		const downloadBtn = screen.getByText("Download Model");
		await waitFor(() => expect(downloadBtn).not.toBeDisabled(), {
			timeout: 3000,
		});

		// Setup 409 Mock
		fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("check"))
				return { ok: true, json: async () => ({ exists: true }) };
			if (u.includes("download")) {
				return {
					ok: false,
					status: 409,
					json: async () => ({
						requires_consent: true,
						warnings: ["Warning 1", "Warning 2"],
					}),
				};
			}
			return { ok: false };
		});

		fireEvent.click(downloadBtn);

		// Verify download was called
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("download"),
				expect.anything(),
			);
		});

		// Expect Dialog to appear
		await waitFor(() => {
			expect(screen.getByText("Confirm Download")).toBeInTheDocument();
			expect(screen.getByText("Warning 1")).toBeInTheDocument();
			expect(screen.getByText("Warning 2")).toBeInTheDocument();
		});
	});

	it("resends with acknowledge_warnings: true when Proceed is clicked", async () => {
		render(<AddModelForm onModelAdded={mockOnModelAdded} />);

		await expandForm();
		const repoInput = screen.getByPlaceholderText("user/repo");
		const fileInput = screen.getByPlaceholderText("model-Q4_K_M.gguf");
		fireEvent.change(repoInput, { target: { value: "warn/repo" } });
		fireEvent.change(fileInput, { target: { value: "warn.gguf" } });

		const downloadBtn = screen.getByText("Download Model");
		await waitFor(() => expect(downloadBtn).not.toBeDisabled(), {
			timeout: 3000,
		});

		// Setup Complex Mock
		fetchMock.mockImplementation(
			async (url: RequestInfo | URL, opts?: RequestInit) => {
				const u = String(url);
				if (u.includes("/check"))
					return { ok: true, json: async () => ({ exists: true }) };

				if (u.includes("download")) {
					const bodyStr = typeof opts?.body === "string" ? opts.body : "{}";
					const body = JSON.parse(bodyStr) as {
						acknowledge_warnings?: boolean;
					};
					if (body.acknowledge_warnings === true) {
						return {
							ok: true,
							status: 200,
							json: async () => ({ success: true }),
						};
					} else {
						return {
							ok: false,
							status: 409,
							json: async () => ({
								success: false,
								requires_consent: true,
								warnings: ["Big File"],
							}),
						};
					}
				}
				return { ok: false };
			},
		);

		fireEvent.click(downloadBtn);

		// Wait for Dialog
		await waitFor(() =>
			expect(screen.getByText("Confirm Download")).toBeInTheDocument(),
		);

		// Click Proceed
		const proceedBtn = screen.getByText("Proceed");
		fireEvent.click(proceedBtn);

		// Verify retry logic
		await waitFor(() => {
			const calls = fetchMock.mock.calls;
			const downloadCalls = calls.filter((c) =>
				String(c[0]).includes("download"),
			);
			expect(downloadCalls.length).toBeGreaterThanOrEqual(2);

			const lastCall = downloadCalls[downloadCalls.length - 1];
			const body = JSON.parse(lastCall[1].body);
			expect(body.acknowledge_warnings).toBe(true);
		});

		expect(screen.queryByText("Confirm Download")).not.toBeInTheDocument();
	});

	it("closes dialog on Cancel", async () => {
		render(<AddModelForm onModelAdded={mockOnModelAdded} />);

		await expandForm();
		const repoInput = screen.getByPlaceholderText("user/repo");
		const fileInput = screen.getByPlaceholderText("model-Q4_K_M.gguf");
		fireEvent.change(repoInput, { target: { value: "warn/repo" } });
		fireEvent.change(fileInput, { target: { value: "warn.gguf" } });

		const downloadBtn = screen.getByText("Download Model");
		await waitFor(() => expect(downloadBtn).not.toBeDisabled(), {
			timeout: 3000,
		});

		// Setup Mock
		fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("check"))
				return { ok: true, json: async () => ({ exists: true }) };
			if (u.includes("download")) {
				return {
					ok: false,
					status: 409,
					json: async () => ({
						requires_consent: true,
						warnings: ["Check me"],
					}),
				};
			}
			return { ok: false };
		});

		fireEvent.click(downloadBtn);
		await waitFor(() =>
			expect(screen.getByText("Confirm Download")).toBeInTheDocument(),
		);

		// Click Cancel
		fireEvent.click(screen.getByText("Cancel"));

		await waitFor(() => {
			expect(screen.queryByText("Confirm Download")).not.toBeInTheDocument();
		});
	});


});
