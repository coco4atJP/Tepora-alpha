import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../../test/test-utils";
import InputArea from "../InputArea";

vi.mock("../PersonaSwitcher", () => ({
	default: () => <div data-testid="persona-switcher" />,
}));

describe("InputArea", () => {
	const mockOnSendMessage = vi.fn();

	const getTextbox = () => screen.getByRole("textbox");
	const getSendButton = () =>
		screen.getByRole("button", { name: /send message/i });
	const getStopButton = () =>
		screen.getByRole("button", { name: /stop generation/i });

	it("renders correctly", () => {
		render(
			<InputArea
				onSendMessage={mockOnSendMessage}
				isProcessing={false}
				isConnected={true}
				currentMode="direct"
			/>,
		);
		expect(getTextbox()).toBeInTheDocument();
		expect(getSendButton()).toBeInTheDocument();
	});

	it("handles input and submission", () => {
		render(
			<InputArea
				onSendMessage={mockOnSendMessage}
				isProcessing={false}
				isConnected={true}
				currentMode="direct"
			/>,
		);

		const input = getTextbox();
		const sendButton = getSendButton();

		fireEvent.change(input, { target: { value: "Hello" } });
		expect(input).toHaveValue("Hello");

		fireEvent.click(sendButton);
		expect(mockOnSendMessage).toHaveBeenCalledWith(
			"Hello",
			"direct",
			[],
			false,
		);
		expect(input).toHaveValue("");
	});

	it("disables input when processing or disconnected", () => {
		const { rerender } = render(
			<InputArea
				onSendMessage={mockOnSendMessage}
				isProcessing={true}
				isConnected={true}
				currentMode="direct"
			/>,
		);

		// When processing, Textbox disabled, Send button replaced by Stop button
		expect(getTextbox()).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: /send message/i }),
		).not.toBeInTheDocument();
		expect(getStopButton()).toBeInTheDocument();

		rerender(
			<InputArea
				onSendMessage={mockOnSendMessage}
				isProcessing={false}
				isConnected={false}
				currentMode="direct"
			/>,
		);

		// When disconnected (and not processing), Textbox and Send button disabled
		expect(getTextbox()).toBeDisabled();
		expect(getSendButton()).toBeDisabled();
	});

	it("sends message with correct mode", () => {
		render(
			<InputArea
				onSendMessage={mockOnSendMessage}
				isProcessing={false}
				isConnected={true}
				currentMode="search"
			/>,
		);

		const input = getTextbox();
		const sendButton = getSendButton();

		fireEvent.change(input, { target: { value: "Search query" } });
		fireEvent.click(sendButton);

		expect(mockOnSendMessage).toHaveBeenCalledWith(
			"Search query",
			"search",
			[],
			false,
		);
	});
});
