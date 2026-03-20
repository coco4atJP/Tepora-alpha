import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { socketCommands } from "../../../stores/socketCommands";
import { useChatStore } from "../../../stores/chatStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSocketConnectionStore } from "../../../stores/socketConnectionStore";
import { useToolConfirmationStore } from "../../../stores/toolConfirmationStore";

vi.mock("../../../utils/sidecar", () => ({
	isDesktop: () => false,
	backendReady: Promise.resolve(),
}));

vi.mock("../../../utils/api", () => ({
	getWsBase: () => "ws://localhost:3001",
}));

vi.mock("../../../utils/sessionToken", () => ({
	getSessionToken: () => Promise.resolve("test-token"),
	refreshSessionToken: () => Promise.resolve("new-token"),
}));

vi.mock("../../../utils/wsAuth", () => ({
	buildWebSocketProtocols: () => ["tepora-auth.test-token"],
}));

class MockWebSocket {
	static instances: MockWebSocket[] = [];

	url: string;
	protocols: string | string[] | undefined;
	readyState: number = WebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	send = vi.fn();
	close = vi.fn();

	constructor(url: string, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
		MockWebSocket.instances.push(this);
	}

	simulateOpen() {
		this.readyState = WebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	simulateMessage(data: object) {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
}

const originalWebSocket = globalThis.WebSocket;

describe("socketCommands", () => {
	beforeEach(() => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		MockWebSocket.instances = [];
		useChatStore.getState().reset();
		useSessionStore.getState().resetToDefault();
		useSocketConnectionStore.getState().reset();
		useToolConfirmationStore.getState().reset();
	});

	afterEach(() => {
		socketCommands.disconnect();
		globalThis.WebSocket = originalWebSocket;
	});

	it("connects and stores socket state", async () => {
		await socketCommands.connect();
		expect(MockWebSocket.instances).toHaveLength(1);
		MockWebSocket.instances[0].simulateOpen();
		expect(useSocketConnectionStore.getState().isConnected).toBe(true);
	});

	it("sendMessage appends a user message", async () => {
		await socketCommands.connect();
		const ws = MockWebSocket.instances[0];
		ws.simulateOpen();

		socketCommands.sendMessage("hello", "chat");

		expect(useChatStore.getState().messages[0]?.content).toBe("hello");
		expect(ws.send).toHaveBeenCalled();
	});

	it("routes tool confirmation requests into dedicated state", async () => {
		await socketCommands.connect();
		const ws = MockWebSocket.instances[0];
		ws.simulateOpen();

		ws.simulateMessage({
			type: "tool_confirmation_request",
			data: {
				requestId: "req-1",
				toolName: "web_search",
				toolArgs: {},
				scope: "native_tool",
				scopeName: "web_search",
				riskLevel: "medium",
				expiryOptions: [300],
			},
		});

		expect(useToolConfirmationStore.getState().pendingToolConfirmation?.requestId).toBe("req-1");
	});
});
