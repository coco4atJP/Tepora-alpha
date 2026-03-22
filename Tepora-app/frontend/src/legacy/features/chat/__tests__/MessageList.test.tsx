import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "../../../test/test-utils";

import type { Message } from "../../../../types";
import MessageList from "../MessageList";

vi.mock("../../../stores", () => ({
	useChatStore: vi.fn(),
	socketCommands: {
		regenerateResponse: vi.fn(),
	},
}));

vi.mock("../../../context/SettingsContext", () => ({
	useSettingsState: () => ({
		config: {},
		originalConfig: null,
		loading: false,
		error: null,
		hasChanges: false,
		saving: false,
	}),
	useAgentSkills: () => ({
		agentSkills: {},
	}),
}));

import { useChatStore } from "../../../stores";

describe("MessageList", () => {
	const scrollIntoViewMock = vi.fn();

	beforeEach(() => {
		vi.resetAllMocks();
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

	it("scrolls to bottom on new message", () => {
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ messages: mockMessages }),
		);
		render(<MessageList />);
		expect(scrollIntoViewMock).toHaveBeenCalled();
	});
});

