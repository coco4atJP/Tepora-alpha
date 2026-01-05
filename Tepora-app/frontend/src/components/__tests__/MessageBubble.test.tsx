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
		// User icon logic check (indirectly via class or presence)
		// Ideally we check for specific classes or aria-labels if available
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
		expect(screen.getByText("Planner")).toBeInTheDocument();
	});

	it("renders search mode label correctly", () => {
		const message: Message = {
			id: "3",
			role: "user", // Note: logic in component shows mode label mainly for user messages if configured?
			// Let's check the code: "modeLabel = message.mode && message.role === 'user' ? ..."
			content: "Search query",
			timestamp: new Date(),
			mode: "search",
		};

		render(<MessageBubble message={message} />);
		expect(screen.getByText("🔍 Search")).toBeInTheDocument();
	});

	it("renders markdown content", () => {
		const message: Message = {
			id: "4",
			role: "assistant",
			content: "**Bold text** and *Italic*",
			timestamp: new Date(),
			isComplete: true,
		};

		render(<MessageBubble message={message} />);
		const boldText = screen.getByText("Bold text");
		expect(boldText.tagName).toBe("STRONG");
	});

	it("renders code blocks", () => {
		const message: Message = {
			id: "5",
			role: "assistant",
			content: '```python\nprint("test")\n```',
			timestamp: new Date(),
			isComplete: true,
		};

		const { container } = render(<MessageBubble message={message} />);
		expect(container.textContent).toContain('print("test")');
		// Check for syntax highlighter presence if possible, or label
		expect(screen.getByLabelText("python code block")).toBeInTheDocument();
	});
});
