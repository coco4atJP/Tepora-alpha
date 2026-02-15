import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "./test-utils";

vi.mock("../features/chat/PersonaSwitcher", () => ({
	default: () => <div data-testid="persona-switcher" />,
}));

vi.mock("../hooks/useSettings", () => ({
	useSettings: () => ({ config: {}, customAgents: {} }),
}));

vi.mock("react-router-dom", async () => {
	const actual = await vi.importActual("react-router-dom");
	return {
		...actual,
		useOutletContext: () => ({
			currentMode: "chat" as ChatMode,
			attachments: [],
			onFileSelect: vi.fn(),
			onRemoveAttachment: vi.fn(),
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		}),
	};
});

Element.prototype.scrollIntoView = vi.fn();

// Mock Stores
const mockSendMessage = vi.fn();
const mockSetSession = vi.fn();
const mockHandleToolConfirmation = vi.fn();
const mockStopGeneration = vi.fn();
const mockClearError = vi.fn();

vi.mock("../stores", () => ({
	useChatStore: vi.fn(),
	useWebSocketStore: vi.fn(),
}));

import ChatInterface from "../features/chat/ChatInterface";
import { useChatStore, useWebSocketStore } from "../stores";
import type { ChatMode } from "../types";

const mockCreateSession = vi.fn();
// Mock useSessions hook
vi.mock("../hooks/useSessions", () => ({
	useSessions: () => ({
		createSession: mockCreateSession,
	}),
}));

describe("ChatInterface Integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Default Store State
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isProcessing: false,
				messages: [],
				error: null,
				clearError: mockClearError,
			}),
		);

		(useWebSocketStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isConnected: true,
				sendMessage: mockSendMessage,
				setSession: mockSetSession,
				pendingToolConfirmation: null,
				handleToolConfirmation: mockHandleToolConfirmation,
				stopGeneration: mockStopGeneration,
			}),
		);
	});

	it("renders initial state correctly", () => {
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isProcessing: false,
				messages: [
					{
						id: "1",
						role: "user",
						content: "Hello",
						timestamp: new Date(1000),
					},
					{
						id: "2",
						role: "assistant",
						content: "Hi there",
						timestamp: new Date(1001),
					},
				],
				error: null,
				clearError: mockClearError,
			}),
		);

		render(<ChatInterface />);

		// Verify messages are displayed
		expect(screen.getByText("Hello")).toBeInTheDocument();
		expect(screen.getByText("Hi there")).toBeInTheDocument();

		// Verify input area is present (uses i18n key in test)
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("handles user input and sends message", async () => {
		render(<ChatInterface />);

		const input = screen.getByRole("textbox");
		const sendButton = screen.getByRole("button", { name: /send/i });

		// Simulate typing
		fireEvent.change(input, { target: { value: "Test Query" } });

		// Simulate send
		fireEvent.click(sendButton);

		// Verify sendMessage called with correct args
		// Assuming ChatMode 'chat' from outlet context mock
		expect(mockSendMessage).toHaveBeenCalledWith(
			"Test Query",
			"chat",
			[],
			false,
			false,
			undefined,
			undefined,
		);
	});

	it("displays error toast when error occurs", () => {
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isProcessing: false,
				messages: [],
				error: "Connection Failed",
				clearError: mockClearError,
			}),
		);

		render(<ChatInterface />);

		expect(screen.getByText("Connection Failed")).toBeInTheDocument();

		// Verify clear error interaction
		const closeBtn = screen.getByRole("button", { name: /close/i });
		fireEvent.click(closeBtn);
		expect(mockClearError).toHaveBeenCalled();
	});

	it("disables input when processing", () => {
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isProcessing: true,
				messages: [],
				error: null,
				clearError: mockClearError,
			}),
		);

		render(<ChatInterface />);

		// Check for stop button or disabled input depending on InputArea implementation
		// If InputArea shows stop button when processing:
		expect(screen.getByLabelText(/stop generation/i)).toBeInTheDocument();

		// Input usually disabled or replaced
		const input = screen.queryByPlaceholderText(/Type a message.../i);
		// It might be disabled or still there, check attribute if implemented
		if (input) {
			expect(input).toBeDisabled();
		}
	});

	it("creates new session when button clicked", () => {
		// mockCreateSession returns a promise
		mockCreateSession.mockResolvedValue({ id: "new-session" });

		render(<ChatInterface />);

		const newSessionBtn = screen.getByRole("button", { name: /new session/i });
		fireEvent.click(newSessionBtn);

		expect(mockCreateSession).toHaveBeenCalled();
		// Wait for promise resolution (implicit if we dont use await here, check if test passes first)
	});
});
