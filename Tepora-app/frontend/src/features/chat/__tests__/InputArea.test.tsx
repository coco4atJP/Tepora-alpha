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

import { useOutletContext } from "react-router-dom";
import { useChatStore, useWebSocketStore } from "../../../stores";

describe("InputArea", () => {
	beforeEach(() => {
		vi.resetAllMocks();

		// Default store implementation
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			(selector) => selector({ isProcessing: false }),
		);
		(
			useWebSocketStore as unknown as ReturnType<typeof vi.fn>
		).mockImplementation((selector) =>
			selector({
				isConnected: true,
				sendMessage: mockSendMessage,
				stopGeneration: mockStopGeneration,
			}),
		);
		(useOutletContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			currentMode: "direct",
			attachments: [],
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		});
	});

	const getTextbox = () => screen.getByRole("textbox");
	const getSendButton = () =>
		screen.getByRole("button", { name: /send message/i });
	const getStopButton = () =>
		screen.getByRole("button", { name: /stop generation/i });

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
		expect(mockSendMessage).toHaveBeenCalledWith("Hello", "direct", [], false, false);
		expect(input).toHaveValue("");
	});

	it("disables input when processing", () => {
		// Mock processing state
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			(selector) => selector({ isProcessing: true }),
		);

		render(<InputArea />);

		// When processing, Textbox disabled, Send button replaced by Stop button
		expect(getTextbox()).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: /send message/i }),
		).not.toBeInTheDocument();
		expect(getStopButton()).toBeInTheDocument();
	});

	it("disables input when disconnected", () => {
		// Mock disconnected state
		(
			useWebSocketStore as unknown as ReturnType<typeof vi.fn>
		).mockImplementation((selector) =>
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
		);
	});
});
