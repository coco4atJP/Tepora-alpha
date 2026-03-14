import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../../../test/test-utils";
import InputArea from "../InputArea";

// Mocks
const mockSendMessage = vi.fn();
const mockStopGeneration = vi.fn();

vi.mock("../../../stores", () => ({
	useWebSocketStore: vi.fn(),
}));

const mockActorSend = vi.fn();

vi.mock("../../../machines/chatMachine", () => ({
	chatActor: {
		send: (...args: unknown[]) => mockActorSend(...args),
		getSnapshot: () => ({ matches: vi.fn() })
	}
}));

vi.mock("@xstate/react", () => ({
	useSelector: vi.fn(),
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
		agentSkills: {},
		skillRoots: [],
	}),
}));

import { useOutletContext } from "react-router-dom";
import { useWebSocketStore } from "../../../stores";
import { useSelector } from "@xstate/react";

describe("InputArea", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockActorSend.mockClear();

		// Reset config defaults
		mockConfig.thinking.chat_default = false;
		mockConfig.thinking.search_default = false;

		// Default state: idle (not generating)
		(useSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((_actor, selector) => {
			// Mocking state.matches
			return selector({
				matches: (stateValue: string) => stateValue === "idle"
			});
		});
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
			0,
			undefined,
			undefined,
			300,
		);
		expect(mockActorSend).toHaveBeenCalledWith({
			type: "SEND_MESSAGE",
			payload: "Hello"
		});
		expect(input).toHaveValue("");
	});

	it("disables input when processing", () => {
		// Mock processing state: generating
		(useSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((_actor, selector) => {
			return selector({
				matches: (stateValue: string) => stateValue === "generating"
			});
		});

		render(<InputArea />);

		// When processing, Textbox disabled, Send button replaced by Stop button
		expect(getTextbox()).toBeDisabled();
		expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
		expect(getStopButton()).toBeInTheDocument();
	});

	it("disables input when disconnected", () => {
		// Default idle state
		(useSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((_actor, selector) => {
			return selector({
				matches: (stateValue: string) => stateValue === "idle"
			});
		});
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

	it("allows sending when in error state", () => {
		// Mock error state
		(useSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((_actor, selector) => {
			return selector({
				matches: (stateValue: string) => stateValue === "error"
			});
		});

		render(<InputArea />);

		// Textbox and Send button should be enabled
		const input = getTextbox();
		expect(input).not.toBeDisabled();

		fireEvent.change(input, { target: { value: "Retry message" } });
		const sendButton = getSendButton();
		expect(sendButton).not.toBeDisabled();

		fireEvent.click(sendButton);
		expect(mockActorSend).toHaveBeenCalledWith({
			type: "SEND_MESSAGE",
			payload: "Retry message"
		});
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
			0,
			undefined,
			undefined,
			300,
		);
		expect(mockActorSend).toHaveBeenCalledWith({
			type: "SEND_MESSAGE",
			payload: ""
		});
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
			0,
			undefined,
			undefined,
			300,
		);
		expect(mockActorSend).toHaveBeenCalledWith({
			type: "SEND_MESSAGE",
			payload: "Search query"
		});
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
			1, // Thinking mode should be true (budget 1)
			undefined,
			undefined,
			300,
		);
		expect(mockActorSend).toHaveBeenCalledWith({
			type: "SEND_MESSAGE",
			payload: "Thinking test"
		});
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
			0, // Thinking 0
			undefined,
			undefined,
			300,
		);
		expect(mockActorSend).toHaveBeenCalledWith({
			type: "SEND_MESSAGE",
			payload: "Chat"
		});

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
			1, // Thinking 1 because search_default is true
			undefined,
			undefined,
			300,
		);
		expect(mockActorSend).toHaveBeenCalledWith({
			type: "SEND_MESSAGE",
			payload: "Search"
		});
	});
});

