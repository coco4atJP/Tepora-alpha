import { describe, expect, it, vi } from "vitest";
import { render, screen } from "../../test/test-utils";
import type { Message } from "../../types";
import MessageList from "../MessageList";

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe("MessageList", () => {
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
			mode: "direct",
			isComplete: true,
		},
	];

	it("renders messages correctly", () => {
		render(<MessageList messages={mockMessages} />);

		expect(screen.getByText("Hello")).toBeInTheDocument();
		expect(screen.getAllByText(/Hi there!/)[0]).toBeInTheDocument();
	});

	it("renders code content in messages", () => {
		const { container } = render(<MessageList messages={mockMessages} />);

		// Check that code content is rendered (as plain text in current implementation)
		expect(container.textContent).toContain('print("hello")');
	});

	it("renders empty state", () => {
		render(<MessageList messages={[]} />);
		expect(screen.getByText("System Ready")).toBeInTheDocument();
	});

	it("scrolls to bottom on new message", () => {
		const { rerender } = render(<MessageList messages={[]} />);
		// It might be called on initial render
		vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear();

		rerender(<MessageList messages={mockMessages} />);
		expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
	});
});
