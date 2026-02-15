import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "../../../test/test-utils";

import type { Message } from "../../../types";
import MessageList from "../MessageList";

// Mock store
vi.mock("../../../stores", () => ({
	useChatStore: vi.fn(),
}));

vi.mock("../../../hooks/useSettings", () => ({
	useSettings: () => ({ config: {}, customAgents: {} }),
}));

import { useChatStore } from "../../../stores";

describe("MessageList", () => {
	// Spy on prototype
	const scrollIntoViewMock = vi.fn();

	beforeEach(() => {
		vi.resetAllMocks();
		// Setup default mocks
		HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
	});

	const mockMessages: Message[] = [
		{
			id: "1",
			role: "user",
			content: "Hello",
			timestamp: new Date("2023-01-01T10:00:00"),
		},
		{
			id: "2",
			role: "assistant",
			content: 'Hi there! Here is some code:\n```python\nprint("hello") \n```',
			timestamp: new Date("2023-01-01T10:00:01"),
			mode: "chat",
			isComplete: true,
		},
	];

	it("renders messages correctly", () => {
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ messages: mockMessages }),
		);
		render(<MessageList />);

		expect(screen.getByText("Hello")).toBeInTheDocument();
		expect(screen.getAllByText(/Hi there!/)[0]).toBeInTheDocument();
	});

	it("renders code content in messages", () => {
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ messages: mockMessages }),
		);
		const { container } = render(<MessageList />);

		expect(container.textContent).toContain('print("hello")');
	});

	it("renders empty state", () => {
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ messages: [] }),
		);
		const { container } = render(<MessageList />);
		expect(container.textContent).toBe("");
	});

	it("scrolls to bottom on new message", () => {
		// Initial render with empty
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ messages: [] }),
		);
		const { rerender } = render(<MessageList />);

		scrollIntoViewMock.mockClear();

		// Update store and rerender
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ messages: mockMessages }),
		);
		rerender(<MessageList />);

		// Ensure new messages are rendered implies re-render happened
		expect(screen.getByText("Hello")).toBeInTheDocument();

		expect(scrollIntoViewMock).toHaveBeenCalled();
	});
});
