import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWebSocketMessageHandlers } from "../chat/useWebSocketMessageHandlers";

// Mock dependencies
const mockDeps = {
    handleChunk: vi.fn(),
    flushAndClose: vi.fn(),
    setIsProcessing: vi.fn(),
    setError: vi.fn(),
    setMessages: vi.fn(),
    setMemoryStats: vi.fn(),
    setSearchResults: vi.fn(),
    setActivityLog: vi.fn(),
    setIsLoadingHistory: vi.fn(),
    isToolApproved: vi.fn().mockReturnValue(false),
    setPendingToolConfirmation: vi.fn(),
};

// Mock react-i18next
vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (key: string, fallback: string) => fallback || key,
    }),
}));

describe("useWebSocketMessageHandlers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns handleMessage function", () => {
        const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));

        expect(result.current.handleMessage).toBeDefined();
        expect(typeof result.current.handleMessage).toBe("function");
    });

    describe("handleMessage", () => {
        it("handles chunk message type", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "chunk", message: "test content" }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.handleChunk).toHaveBeenCalled();
        });

        it("handles done message type", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "done" }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.flushAndClose).toHaveBeenCalled();
            expect(mockDeps.setIsProcessing).toHaveBeenCalledWith(false);
        });

        it("handles error message type", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "error", message: "Test error" }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.setError).toHaveBeenCalledWith("Test error");
            expect(mockDeps.setIsProcessing).toHaveBeenCalledWith(false);
        });

        it("handles stats message type", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));
            const statsData = { total_events: 10, recent_events: 5 };

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "stats", data: statsData }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.setMemoryStats).toHaveBeenCalledWith(statsData);
        });

        it("handles search_results message type", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));
            const searchResults = [{ title: "Result 1", url: "http://example.com" }];

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "search_results", data: searchResults }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.setSearchResults).toHaveBeenCalledWith(searchResults);
        });

        it("handles history message type", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));
            const messages = [
                { id: "1", role: "user", content: "Hello", timestamp: new Date().toISOString() },
            ];

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "history", messages }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.setMessages).toHaveBeenCalled();
            expect(mockDeps.setIsLoadingHistory).toHaveBeenCalledWith(false);
        });

        it("handles stopped message type", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "stopped" }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.flushAndClose).toHaveBeenCalled();
            expect(mockDeps.setIsProcessing).toHaveBeenCalledWith(false);
        });

        it("handles tool_confirmation_request when tool not approved", () => {
            mockDeps.isToolApproved.mockReturnValue(false);
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));
            const request = { toolName: "test_tool", requestId: "123" };

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "tool_confirmation_request", data: request }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.setPendingToolConfirmation).toHaveBeenCalledWith(request);
        });

        it("does not show confirmation dialog for already approved tools", () => {
            mockDeps.isToolApproved.mockReturnValue(true);
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));
            const request = { toolName: "approved_tool", requestId: "456" };

            const event = new MessageEvent("message", {
                data: JSON.stringify({ type: "tool_confirmation_request", data: request }),
            });

            result.current.handleMessage(event);
            expect(mockDeps.setPendingToolConfirmation).not.toHaveBeenCalled();
        });

        it("handles parse error gracefully", () => {
            const { result } = renderHook(() => useWebSocketMessageHandlers(mockDeps));

            const event = new MessageEvent("message", {
                data: "invalid json",
            });

            // Should not throw
            expect(() => result.current.handleMessage(event)).not.toThrow();
            expect(mockDeps.setError).toHaveBeenCalledWith("Failed to parse server message");
        });
    });
});
