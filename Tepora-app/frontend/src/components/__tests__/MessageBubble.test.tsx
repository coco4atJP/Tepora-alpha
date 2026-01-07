import { describe, expect, it } from "vitest";
import { render, screen } from "../../test/test-utils";
import type { Message } from "../../types";
import MessageBubble from "../MessageBubble";

describe("MessageBubble", () => {
	it("renders user message correctly", () => {
		const message: Message = {
			id: "1",
			role: "user",
			content: "Hello world",
			timestamp: new Date("2023-01-01T10:00:00"),
		};

		render(<MessageBubble message={message} />);
		expect(screen.getByText("Hello world")).toBeInTheDocument();
	});

	it("renders assistant message correctly", () => {
		const message: Message = {
			id: "2",
			role: "assistant",
			content: "Hello user",
			timestamp: new Date("2023-01-01T10:00:01"),
			agentName: "Planner",
			mode: "agent",
			isComplete: true,
		};

		render(<MessageBubble message={message} />);
		expect(screen.getByText("Hello user")).toBeInTheDocument();
		// Note: Current simplified implementation does not display agentName
	});

	it("renders message content with special characters", () => {
		const message: Message = {
			id: "3",
			role: "user",
			content: "Search query with special chars: @#$%",
			timestamp: new Date(),
			mode: "search",
		};

		render(<MessageBubble message={message} />);
		expect(
			screen.getByText("Search query with special chars: @#$%"),
		).toBeInTheDocument();
	});

	it("renders message content as markdown", () => {
		const message: Message = {
			id: "4",
			role: "assistant",
			content: "**Bold text** and *Italic*",
			timestamp: new Date(),
			isComplete: true,
		};

		const { container } = render(<MessageBubble message={message} />);
		expect(container.querySelector("strong")).toHaveTextContent("Bold text");
		expect(container.querySelector("em")).toHaveTextContent("Italic");
	});

	it("renders code content", () => {
		const message: Message = {
			id: "5",
			role: "assistant",
			content: '```python\nprint("test")\n```',
			timestamp: new Date(),
			isComplete: true,
		};

		const { container } = render(<MessageBubble message={message} />);
		expect(container.querySelector("code")).toBeInTheDocument();
		expect(container.textContent).toContain('print("test")');
	});
});
