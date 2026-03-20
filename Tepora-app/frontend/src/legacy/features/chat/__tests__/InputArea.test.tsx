import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "../../../test/test-utils";
import InputArea from "../InputArea";

const mockSendMessage = vi.fn();
const mockStopGeneration = vi.fn();

vi.mock("../../../stores", () => ({
	useSocketConnectionStore: vi.fn((selector) =>
		selector({
			isConnected: true,
		}),
	),
	socketCommands: {
		sendMessage: (...args: unknown[]) => mockSendMessage(...args),
		stopGeneration: () => mockStopGeneration(),
	},
}));

const mockActorSend = vi.fn();

vi.mock("../../../machines/chatMachine", () => ({
	chatActor: {
		send: (...args: unknown[]) => mockActorSend(...args),
		getSnapshot: () => ({ matches: vi.fn() }),
	},
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

const mockConfig = {
	app: {
		graph_execution_timeout: 300,
	},
	thinking: {
		chat_default: false,
		search_default: false,
	},
};

vi.mock("../../../context/SettingsContext", () => ({
	useSettingsState: () => ({
		config: mockConfig,
	}),
	useAgentSkills: () => ({
		agentSkills: {},
	}),
}));

import { useOutletContext } from "react-router-dom";
import { useSelector } from "@xstate/react";
import { useSocketConnectionStore } from "../../../stores";

describe("InputArea", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		(useSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((_actor, selector) =>
			selector({
				matches: (stateValue: string) => stateValue === "idle",
			}),
		);
		(useOutletContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			currentMode: "chat",
			attachments: [],
			clearAttachments: vi.fn(),
			skipWebSearch: false,
		});
	});

	it("renders correctly", () => {
		render(<InputArea />);
		expect(screen.getByRole("textbox")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
	});

	it("handles input and submission", () => {
		render(<InputArea />);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Hello" } });
		fireEvent.click(screen.getByRole("button", { name: /send message/i }));
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
			payload: "Hello",
		});
	});

	it("disables input when disconnected", () => {
		(useSocketConnectionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
			selector({
				isConnected: false,
			}),
		);
		render(<InputArea />);
		expect(screen.getByRole("textbox")).toBeDisabled();
	});
});
