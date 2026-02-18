/**
 * websocketStore Unit Tests
 *
 * Tests cover:
 * - Initial state
 * - calculateBackoff (exponential backoff helper)
 * - disconnect behavior
 * - sendMessage (connected / disconnected cases)
 * - sendRaw
 * - stopGeneration
 * - setSession
 * - Tool confirmation flow
 * - handleMessage: chunk / done / stopped / error / stats / search_results / activity / tool_confirmation_request / history
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../../stores/chatStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { useWebSocketStore } from "../../../stores/websocketStore";

// ============================================================================
// Mocks
// ============================================================================

// sidecar & api utilities
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
    buildWebSocketProtocols: (_token: string) => ["tepora-auth.test-token"],
}));

// ============================================================================
// MockWebSocket helper
// ============================================================================

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
    close = vi.fn(() => {
        this.readyState = WebSocket.CLOSED;
    });

    constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
        MockWebSocket.instances.push(this);
    }

    /** テストからサーバー→クライアントメッセージをシミュレートする */
    simulateMessage(data: object) {
        if (this.onmessage) {
            this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }));
        }
    }

    /** WebSocket OPEN イベントをシミュレート */
    simulateOpen() {
        this.readyState = WebSocket.OPEN;
        if (this.onopen) {
            this.onopen(new Event("open"));
        }
    }

    /** WebSocket CLOSE イベントをシミュレート */
    simulateClose(code = 1000) {
        this.readyState = WebSocket.CLOSED;
        if (this.onclose) {
            const event = new CloseEvent("close", { code, wasClean: true });
            this.onclose(event);
        }
    }
}

// グローバルの WebSocket をモックに差し替え
const originalWebSocket = globalThis.WebSocket;

// ============================================================================
// Helpers
// ============================================================================

const resetAllStores = () => {
    useChatStore.getState().reset();
    useSessionStore.getState().resetToDefault();
    // websocketStore はシングルトンなので disconnect で後片付け
    useWebSocketStore.getState().disconnect();
    // pendingToolConfirmation を明示的にリセット（テスト間の状態汚染を防ぐ）
    useWebSocketStore.getState().setPendingToolConfirmation(null);
    MockWebSocket.instances = [];
};

// ============================================================================
// Tests
// ============================================================================

describe("websocketStore", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
        resetAllStores();
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.WebSocket = originalWebSocket;
        resetAllStores();
    });

    // ==========================================================================
    // 初期状態
    // ==========================================================================

    describe("initialState", () => {
        it("正しい初期状態を持つ", () => {
            const state = useWebSocketStore.getState();
            expect(state.isConnected).toBe(false);
            expect(state.socket).toBeNull();
            expect(state.reconnectAttempts).toBe(0);
            expect(state.pendingToolConfirmation).toBeNull();
        });
    });

    // ==========================================================================
    // connect
    // ==========================================================================

    describe("connect", () => {
        it("WebSocketを作成してソケットをstoreに保存する", async () => {
            await useWebSocketStore.getState().connect();

            expect(MockWebSocket.instances).toHaveLength(1);
            expect(useWebSocketStore.getState().socket).not.toBeNull();
        });

        it("接続成功後にisConnectedがtrueになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            expect(useWebSocketStore.getState().isConnected).toBe(true);
        });

        it("重複呼び出し時は新しいSocketを作成しない", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            // 2回目の connect()
            await useWebSocketStore.getState().connect();

            expect(MockWebSocket.instances).toHaveLength(1);
        });
    });

    // ==========================================================================
    // disconnect
    // ==========================================================================

    describe("disconnect", () => {
        it("disconnectでisConnectedがfalseになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().disconnect();

            expect(useWebSocketStore.getState().isConnected).toBe(false);
        });

        it("disconnectでsocketがnullになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().disconnect();

            expect(useWebSocketStore.getState().socket).toBeNull();
        });

        it("ws.close()が呼ばれる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().disconnect();

            expect(ws.close).toHaveBeenCalled();
        });
    });

    // ==========================================================================
    // sendMessage
    // ==========================================================================

    describe("sendMessage", () => {
        it("接続中の場合にメッセージを送信できる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().sendMessage("Hello", "chat");

            expect(ws.send).toHaveBeenCalledTimes(
                // setSession (on open) + sendMessage
                2,
            );
            const lastCall = ws.send.mock.calls[ws.send.mock.calls.length - 1][0];
            const parsed = JSON.parse(lastCall);
            expect(parsed.message).toBe("Hello");
            expect(parsed.mode).toBe("chat");
        });

        it("未接続の場合にエラーが設定される", () => {
            // 接続せずに送信
            useWebSocketStore.getState().sendMessage("Hello", "chat");

            expect(useChatStore.getState().error).toBe("Not connected to server");
        });

        it("送信時にユーザーメッセージがchatStoreに追加される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().sendMessage("テスト", "chat");

            const { messages } = useChatStore.getState();
            const userMessages = messages.filter((m) => m.role === "user");
            expect(userMessages).toHaveLength(1);
            expect(userMessages[0].content).toBe("テスト");
        });

        it("送信時にisProcessingがtrueになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().sendMessage("テスト", "chat");

            expect(useChatStore.getState().isProcessing).toBe(true);
        });
    });

    // ==========================================================================
    // sendRaw
    // ==========================================================================

    describe("sendRaw", () => {
        it("任意のオブジェクトを送信できる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().sendRaw({ type: "stop" });

            const calls = ws.send.mock.calls;
            const stopCall = calls.find((c: string[]) => {
                const d = JSON.parse(c[0]);
                return d.type === "stop";
            });
            expect(stopCall).toBeDefined();
        });

        it("未接続の場合は送信しない（警告のみ）", () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
            useWebSocketStore.getState().sendRaw({ type: "stop" });
            expect(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });

    // ==========================================================================
    // stopGeneration
    // ==========================================================================

    describe("stopGeneration", () => {
        it("stop メッセージを送信する", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().stopGeneration();

            const calls = ws.send.mock.calls;
            const stopCall = calls.find((c: string[]) => {
                const d = JSON.parse(c[0]);
                return d.type === "stop";
            });
            expect(stopCall).toBeDefined();
        });

        it("stopGeneration後にisProcessingがfalseになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useChatStore.getState().setIsProcessing(true);
            useWebSocketStore.getState().stopGeneration();

            expect(useChatStore.getState().isProcessing).toBe(false);
        });
    });

    // ==========================================================================
    // setSession
    // ==========================================================================

    describe("setSession", () => {
        it("セッションIDがsessionStoreに保存される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().setSession("session-abc");

            expect(useSessionStore.getState().currentSessionId).toBe("session-abc");
        });

        it("set_session メッセージが送信される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useWebSocketStore.getState().setSession("session-xyz");

            const calls = ws.send.mock.calls;
            const sessionCall = calls.find((c: string[]) => {
                const d = JSON.parse(c[0]);
                return d.type === "set_session" && d.sessionId === "session-xyz";
            });
            expect(sessionCall).toBeDefined();
        });

        it("setSession時にchatStoreのメッセージがクリアされる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useChatStore.getState().addUserMessage("古いメッセージ", "chat");
            useWebSocketStore.getState().setSession("new-session");

            expect(useChatStore.getState().messages).toHaveLength(0);
        });
    });

    // ==========================================================================
    // handleMessage - WebSocket受信メッセージ処理
    // ==========================================================================

    describe("handleMessage: chunk", () => {
        it("chunk メッセージでhandleStreamChunkが呼ばれる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            const handleStreamChunk = vi.spyOn(useChatStore.getState(), "handleStreamChunk");

            ws.simulateMessage({
                type: "chunk",
                message: "Hello",
                nodeId: "node1",
            });

            expect(handleStreamChunk).toHaveBeenCalledWith("Hello", {
                mode: undefined,
                agentName: undefined,
                nodeId: "node1",
            });
        });
    });

    describe("handleMessage: done", () => {
        it("done メッセージでfinalizeStreamが呼ばれる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            const finalizeStream = vi.spyOn(useChatStore.getState(), "finalizeStream");
            ws.simulateMessage({ type: "done" });

            expect(finalizeStream).toHaveBeenCalled();
        });

        it("done メッセージでisProcessingがfalseになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useChatStore.getState().setIsProcessing(true);
            ws.simulateMessage({ type: "done" });

            expect(useChatStore.getState().isProcessing).toBe(false);
        });
    });

    describe("handleMessage: stopped", () => {
        it("stopped メッセージでfinalizeStreamが呼ばれてisProcessingがfalseになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useChatStore.getState().setIsProcessing(true);
            const finalizeStream = vi.spyOn(useChatStore.getState(), "finalizeStream");
            ws.simulateMessage({ type: "stopped" });

            expect(finalizeStream).toHaveBeenCalled();
            expect(useChatStore.getState().isProcessing).toBe(false);
        });
    });

    describe("handleMessage: error", () => {
        it("error メッセージでchatStoreにエラーが設定される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({ type: "error", message: "サーバーエラー" });

            expect(useChatStore.getState().error).toBe("サーバーエラー");
        });

        it("error メッセージでsystemメッセージが追加される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({ type: "error", message: "サーバーエラー" });

            const { messages } = useChatStore.getState();
            const systemMessages = messages.filter((m) => m.role === "system");
            expect(systemMessages).toHaveLength(1);
            expect(systemMessages[0].content).toContain("サーバーエラー");
        });

        it("error メッセージでisProcessingがfalseになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useChatStore.getState().setIsProcessing(true);
            ws.simulateMessage({ type: "error", message: "エラー" });

            expect(useChatStore.getState().isProcessing).toBe(false);
        });

        it("message未指定の場合にデフォルトエラーメッセージが使われる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({ type: "error" });

            expect(useChatStore.getState().error).toBe("Unknown error");
        });
    });

    describe("handleMessage: stats", () => {
        it("stats メッセージでmemoryStatsが更新される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            const statsData = {
                char_memory: { total_events: 5, total_tokens_in_memory: 100, mean_event_size: 20 },
            };
            ws.simulateMessage({ type: "stats", data: statsData });

            expect(useChatStore.getState().memoryStats).toEqual(statsData);
        });
    });

    describe("handleMessage: search_results", () => {
        it("search_results メッセージでsearchResultsが更新される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            const results = [
                { title: "Result 1", url: "http://example.com/1", snippet: "snippet 1" },
                { title: "Result 2", url: "http://example.com/2", snippet: "snippet 2" },
            ];
            ws.simulateMessage({ type: "search_results", data: results });

            expect(useChatStore.getState().searchResults).toEqual(results);
        });
    });

    describe("handleMessage: activity", () => {
        it("activity メッセージでactivityLogが更新される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({
                type: "activity",
                data: {
                    id: "generate_order",
                    status: "processing",
                    message: "Planning...",
                },
            });

            const { activityLog } = useChatStore.getState();
            expect(activityLog).toHaveLength(1);
            // AGENT_MAPPING により generate_order -> "Planner"
            expect(activityLog[0].agent_name).toBe("Planner");
            expect(activityLog[0].status).toBe("processing");
        });

        it("done ステータスが completed にマッピングされる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({
                type: "activity",
                data: {
                    id: "supervisor",
                    status: "done",
                    message: "Complete",
                },
            });

            const { activityLog } = useChatStore.getState();
            expect(activityLog[0].status).toBe("completed");
        });
    });

    describe("handleMessage: tool_confirmation_request", () => {
        it("pendingToolConfirmationが設定される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({
                type: "tool_confirmation_request",
                data: {
                    requestId: "req-1",
                    toolName: "web_search",
                    toolArgs: { query: "test" },
                    description: "Search the web",
                },
            });

            const { pendingToolConfirmation } = useWebSocketStore.getState();
            expect(pendingToolConfirmation).not.toBeNull();
            expect(pendingToolConfirmation?.toolName).toBe("web_search");
            expect(pendingToolConfirmation?.requestId).toBe("req-1");
        });

        it("承認済みツールは自動承認される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            // ツールを事前に承認済みに設定
            useWebSocketStore.getState().approveToolForSession("auto_tool");

            ws.simulateMessage({
                type: "tool_confirmation_request",
                data: {
                    requestId: "req-auto",
                    toolName: "auto_tool",
                    toolArgs: {},
                },
            });

            // pendingToolConfirmation は設定されない（自動承認）
            expect(useWebSocketStore.getState().pendingToolConfirmation).toBeNull();

            // tool_confirmation_response が送信される
            const calls = ws.send.mock.calls;
            const responseCall = calls.find((c: string[]) => {
                const d = JSON.parse(c[0]);
                return d.type === "tool_confirmation_response" && d.requestId === "req-auto";
            });
            expect(responseCall).toBeDefined();
        });
    });

    describe("handleMessage: history", () => {
        it("history メッセージでchatStoreのメッセージが更新される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({
                type: "history",
                messages: [
                    {
                        id: "h1",
                        role: "user",
                        content: "過去のメッセージ",
                        timestamp: new Date().toISOString(),
                    },
                ],
            });

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0].content).toBe("過去のメッセージ");
        });

        it("historyのtimestampがDateオブジェクトに変換される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({
                type: "history",
                messages: [
                    {
                        id: "h1",
                        role: "user",
                        content: "test",
                        timestamp: "2024-01-01T00:00:00.000Z",
                    },
                ],
            });

            const { messages } = useChatStore.getState();
            expect(messages[0].timestamp).toBeInstanceOf(Date);
        });

        it("historyメッセージ受信後にisLoadingHistoryがfalseになる", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            useSessionStore.getState().setCurrentSession("session-1"); // sets isLoadingHistory: true
            expect(useSessionStore.getState().isLoadingHistory).toBe(true);

            ws.simulateMessage({ type: "history", messages: [] });

            expect(useSessionStore.getState().isLoadingHistory).toBe(false);
        });
    });

    describe("handleMessage: 不正なJSON", () => {
        it("不正なJSONデータを受信してもエラーをスローしない", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            expect(() => {
                if (ws.onmessage) {
                    ws.onmessage(new MessageEvent("message", { data: "invalid json{{" }));
                }
            }).not.toThrow();

            expect(useChatStore.getState().error).toBe("Failed to parse server message");
        });
    });

    // ==========================================================================
    // Tool Confirmation Actions
    // ==========================================================================

    describe("handleToolConfirmation", () => {
        it("承認応答が送信されpendingが解除される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            // pending を設定
            ws.simulateMessage({
                type: "tool_confirmation_request",
                data: {
                    requestId: "req-confirm",
                    toolName: "file_read",
                    toolArgs: {},
                },
            });

            useWebSocketStore.getState().handleToolConfirmation("req-confirm", true, false);

            // pendingが解除
            expect(useWebSocketStore.getState().pendingToolConfirmation).toBeNull();

            // 応答が送信
            const calls = ws.send.mock.calls;
            const responseCall = calls.find((c: string[]) => {
                const d = JSON.parse(c[0]);
                return d.type === "tool_confirmation_response" && d.requestId === "req-confirm";
            });
            expect(responseCall).toBeDefined();
        });

        it("remember=trueの場合にツールがセッション承認済みリストに追加される", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({
                type: "tool_confirmation_request",
                data: {
                    requestId: "req-remember",
                    toolName: "remember_tool",
                    toolArgs: {},
                },
            });

            useWebSocketStore.getState().handleToolConfirmation("req-remember", true, true);

            expect(useWebSocketStore.getState().isToolApproved("remember_tool")).toBe(true);
        });

        it("remember=falseの場合はセッション承認済みリストに追加されない", async () => {
            await useWebSocketStore.getState().connect();
            const ws = MockWebSocket.instances[0];
            ws.simulateOpen();

            ws.simulateMessage({
                type: "tool_confirmation_request",
                data: {
                    requestId: "req-no-remember",
                    toolName: "forget_tool",
                    toolArgs: {},
                },
            });

            useWebSocketStore.getState().handleToolConfirmation("req-no-remember", true, false);

            expect(useWebSocketStore.getState().isToolApproved("forget_tool")).toBe(false);
        });
    });

    describe("approveToolForSession / isToolApproved", () => {
        it("approveToolForSessionでツールを承認できる", () => {
            useWebSocketStore.getState().approveToolForSession("my_tool");
            expect(useWebSocketStore.getState().isToolApproved("my_tool")).toBe(true);
        });

        it("承認されていないツールはfalseを返す", () => {
            expect(useWebSocketStore.getState().isToolApproved("unknown_tool")).toBe(false);
        });
    });
});
