import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../../../test/test-utils";
import InputArea from "../InputArea";

// Mocks
const mockSendMessage = vi.fn();
const mockStopGeneration = vi.fn();

vi.mock("../../../stores", () => ({
	useChatStore: vi.fn(),
	useWebSocketStore: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
	const actual = await vi.importActual("react-router-dom");
	return {
		...actual,
		useOutletContext: vi.fn(),
	};
});

vi.mock("../PersonaSwitcher", () => ({
	default: () => <div data-testid="persona-switcher" />,
}));

// Mutable config for testing
const mockConfig = {
	app: {
		graph_execution_timeout: 300,
	},
	thinking: {
		chat_default: false,
		search_default: false,
	},
};

vi.mock("../../../hooks/useSettings", () => ({
	useSettings: () => ({
		config: mockConfig,
		customAgents: {},
	}),
}));

import { useOutletContext } from "react-router-dom";
import { useChatStore, useWebSocketStore } from "../../../stores";

describe("InputArea", () => {
	beforeEach(() => {
		vi.resetAllMocks();

		// Reset config defaults
		mockConfig.thinking.chat_default = false;
		mockConfig.thinking.search_default = false;

		// Default store implementation
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ isProcessing: false }),
		);
		(useWebSocketStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isConnected: true,
				sendMessage: mockSendMessage,
				stopGeneration: mockStopGeneration,
			}),
		);
		(useOutletContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			currentMode: "chat",
			attachments: [],
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		});
	});

	const getTextbox = () => screen.getByRole("textbox");
	const getSendButton = () => screen.getByRole("button", { name: /send message/i });
	const getStopButton = () => screen.getByRole("button", { name: /stop generation/i });

	it("renders correctly", () => {
		render(<InputArea />);
		expect(getTextbox()).toBeInTheDocument();
		expect(getSendButton()).toBeInTheDocument();
	});

	it("handles input and submission", () => {
		render(<InputArea />);

		const input = getTextbox();
		const sendButton = getSendButton();

		fireEvent.change(input, { target: { value: "Hello" } });
		expect(input).toHaveValue("Hello");

		fireEvent.click(sendButton);
		expect(mockSendMessage).toHaveBeenCalledWith(
			"Hello",
			"chat",
			[],
			false,
			false,
			undefined,
			undefined,
			300,
		);
		expect(input).toHaveValue("");
	});

	it("disables input when processing", () => {
		// Mock processing state
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({ isProcessing: true }),
		);

		render(<InputArea />);

		// When processing, Textbox disabled, Send button replaced by Stop button
		expect(getTextbox()).toBeDisabled();
		expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
		expect(getStopButton()).toBeInTheDocument();
	});

	it("disables input when disconnected", () => {
		// Mock disconnected state
		(useWebSocketStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isConnected: false,
				sendMessage: mockSendMessage,
				stopGeneration: mockStopGeneration,
			}),
		);

		render(<InputArea />);

		// When disconnected (and not processing), Textbox and Send button disabled
		expect(getTextbox()).toBeDisabled();
		expect(getSendButton()).toBeDisabled();
	});

	it("prevents sending empty messages without attachments", () => {
		render(<InputArea />);
		const sendButton = getSendButton();
		const input = getTextbox();

		// Empty input
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.click(sendButton);

		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it("allows sending empty message if it has attachments", () => {
		(useOutletContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			currentMode: "chat",
			attachments: ["file1.txt"],
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		});

		render(<InputArea />);
		const sendButton = getSendButton();

		// Empty input but has attachments
		fireEvent.click(sendButton);

		expect(mockSendMessage).toHaveBeenCalledWith(
			"",
			"chat",
			["file1.txt"],
			false,
			false,
			undefined,
			undefined,
			300,
		);
	});

	it("sends message with correct mode", () => {
		(useOutletContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			currentMode: "search",
			attachments: [],
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		});

		render(<InputArea />);

		const input = getTextbox();
		const sendButton = getSendButton();

		fireEvent.change(input, { target: { value: "Search query" } });
		fireEvent.click(sendButton);

		expect(mockSendMessage).toHaveBeenCalledWith(
			"Search query",
			"search",
			[],
			false,
			false,
			undefined,
			undefined,
			300,
		);
	});

	it("initializes thinking mode based on config", () => {
		mockConfig.thinking.chat_default = true;

		render(<InputArea />);
		const sendButton = getSendButton();
		const input = getTextbox();

		fireEvent.change(input, { target: { value: "Thinking test" } });
		fireEvent.click(sendButton);

		expect(mockSendMessage).toHaveBeenCalledWith(
			"Thinking test",
			"chat",
			[],
			false,
			true, // Thinking mode should be true
			undefined,
			undefined,
			300,
		);
	});

	it("updates thinking mode when mode changes", () => {
		mockConfig.thinking.chat_default = false;
		mockConfig.thinking.search_default = true;

		const { rerender } = render(<InputArea />);

		// Initial: Chat mode (default false)
		let input = getTextbox();
		let sendButton = getSendButton();
		fireEvent.change(input, { target: { value: "Chat" } });
		fireEvent.click(sendButton);
		expect(mockSendMessage).toHaveBeenCalledWith(
			"Chat",
			"chat", // currentMode is chat by default in mock
			[],
			false,
			false, // Thinking false
			undefined,
			undefined,
			300,
		);

		// Change usage of useOutletContext for next render
		(useOutletContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			currentMode: "search",
			attachments: [],
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		});

		// Rerender to trigger effect
		rerender(<InputArea />);

		input = getTextbox();
		sendButton = getSendButton();
		fireEvent.change(input, { target: { value: "Search" } });
		fireEvent.click(sendButton);

		expect(mockSendMessage).toHaveBeenCalledWith(
			"Search",
			"search",
			[],
			false,
			true, // Thinking true because search_default is true
			undefined,
			undefined,
			300,
		);
	});
});
