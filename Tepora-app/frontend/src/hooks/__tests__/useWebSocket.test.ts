import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebSocket } from "../useWebSocket";

// Mock sessionToken module to avoid async loading in tests
vi.mock("../../utils/sessionToken", () => ({
	getSessionToken: vi.fn().mockResolvedValue(null),
	getSessionTokenSync: vi.fn().mockReturnValue(null),
	refreshSessionToken: vi.fn().mockResolvedValue(null),
}));

// Capture instances to interact with them
let createdSockets: MockWebSocket[] = [];

class MockWebSocket {
	url: string;
	onopen: (() => void) | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onmessage: ((event: any) => void) | null = null;
	onclose: (() => void) | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	onerror: ((error: any) => void) | null = null;
	readyState: number = WebSocket.CONNECTING;
	send = vi.fn();
	close = vi.fn();

	constructor(url: string) {
		this.url = url;
		createdSockets.push(this);
		setTimeout(() => {
			this.readyState = WebSocket.OPEN;
			this.onopen?.();
		}, 0);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = MockWebSocket;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket.OPEN = 1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket.CONNECTING = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket.CLOSING = 2;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket.CLOSED = 3;

describe("useWebSocket", () => {
	beforeEach(() => {
		createdSockets = [];
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	// Helper to flush microtask queue along with timers
	const flushPromisesAndTimers = async () => {
		await vi.runAllTimersAsync();
	};

	it("should connect on mount", async () => {
		const { result } = renderHook(() => useWebSocket());

		expect(result.current.isConnected).toBe(false);

		await act(async () => {
			await flushPromisesAndTimers();
		});

		expect(result.current.isConnected).toBe(true);
		expect(createdSockets.length).toBe(1);
	});

	it("should receive messages", async () => {
		const { result } = renderHook(() => useWebSocket());

		await act(async () => {
			await flushPromisesAndTimers();
		});

		const socket = createdSockets[0];
		const testMessage = {
			type: "chunk",
			message: "Hello from server",
			mode: "direct",
		};

		await act(async () => {
			socket.onmessage?.({ data: JSON.stringify(testMessage) });
		});

		// チャンクバッファリング（50ms）のタイマーを進める
		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		expect(result.current.messages).toHaveLength(1);
		expect(result.current.messages[0].content).toBe("Hello from server");
	});

	it("should send messages", async () => {
		const { result } = renderHook(() => useWebSocket());

		await act(async () => {
			await flushPromisesAndTimers();
		});

		const socket = createdSockets[0];

		await act(async () => {
			result.current.sendMessage("Hello server");
		});

		expect(socket.send).toHaveBeenCalledWith(
			expect.stringContaining("Hello server"),
		);
		expect(result.current.messages).toHaveLength(1); // User message added optimistically
	});

	it("should cleanup on unmount", async () => {
		const { unmount } = renderHook(() => useWebSocket());

		await act(async () => {
			await flushPromisesAndTimers();
		});

		const socket = createdSockets[0];
		unmount();

		expect(socket.close).toHaveBeenCalled();
	});
});
