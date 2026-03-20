import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "./test-utils";

vi.mock("../features/chat/PersonaSwitcher", () => ({
	default: () => <div data-testid="persona-switcher" />,
}));

vi.mock("../context/SettingsContext", () => ({
	useSettingsState: () => ({
		config: {
			app: {
				graph_execution_timeout: 300,
			},
		},
	}),
	useAgentSkills: () => ({ agentSkills: {} }),
}));

vi.mock("react-router-dom", async () => {
	const actual = await vi.importActual("react-router-dom");
	return {
		...actual,
		useOutletContext: () => ({
			currentMode: "chat" as const,
			attachments: [],
			onFileSelect: vi.fn(),
			onRemoveAttachment: vi.fn(),
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		}),
	};
});

Element.prototype.scrollIntoView = vi.fn();

const mockSendMessage = vi.fn();
const mockSetSession = vi.fn();
const mockHandleToolConfirmation = vi.fn();
const mockStopGeneration = vi.fn();
const mockClearError = vi.fn();
const mockActorSend = vi.fn();

vi.mock("../stores", () => ({
	useChatStore: vi.fn(),
	useSocketConnectionStore: vi.fn(),
	useToolConfirmationStore: vi.fn(),
	socketCommands: {
		sendMessage: (...args: unknown[]) => mockSendMessage(...args),
		setSession: (...args: unknown[]) => mockSetSession(...args),
		handleToolConfirmation: (...args: unknown[]) => mockHandleToolConfirmation(...args),
		stopGeneration: () => mockStopGeneration(),
	},
}));

vi.mock("../machines/chatMachine", () => ({
	chatActor: {
		send: (...args: unknown[]) => mockActorSend(...args),
		getSnapshot: () => ({ matches: vi.fn() }),
	},
}));

vi.mock("@xstate/react", () => ({
	useSelector: vi.fn(),
}));

import ChatInterface from "../features/chat/ChatInterface";
import { useChatStore, useSocketConnectionStore, useToolConfirmationStore } from "../stores";
import { useSelector } from "@xstate/react";

const mockCreateSession = vi.fn();
vi.mock("../hooks/useSessions", () => ({
	useSessions: () => ({
		createSession: mockCreateSession,
	}),
}));

describe("ChatInterface Integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(useSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((_actor, selector) =>
			selector({ matches: (stateValue: string) => stateValue === "idle" }),
		);
		(useChatStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				messages: [],
				error: null,
				clearError: mockClearError,
			}),
		);
		(useSocketConnectionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isConnected: true,
			}),
		);
		(useToolConfirmationStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				pendingToolConfirmation: null,
			}),
		);
	});

	it("renders initial state correctly", () => {
		render(<ChatInterface />);
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("handles user input and sends message", () => {
		render(<ChatInterface />);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Test Query" } });
		fireEvent.click(screen.getByRole("button", { name: /send/i }));
		expect(mockSendMessage).toHaveBeenCalledWith(
			"Test Query",
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
			payload: "Test Query",
		});
	});
});
