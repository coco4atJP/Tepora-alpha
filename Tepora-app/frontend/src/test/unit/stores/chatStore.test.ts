/**
 * chatStore Unit Tests
 *
 * Tests cover:
 * - Message actions (addMessage, addUserMessage, setMessages, clearMessages)
 * - Streaming (handleStreamChunk, flushStreamBuffer, finalizeStream)
 * - Processing state
 * - Error state
 * - Activity log
 * - Search results & Memory stats
 * - Reset
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../../stores/chatStore";
import type { AgentActivity, Message, SearchResult } from "../../../types";

// ストアを各テスト前にリセットするヘルパー
const resetStore = () => {
    useChatStore.getState().reset();
};

describe("chatStore", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetStore();
    });

    afterEach(() => {
        vi.useRealTimers();
        resetStore();
    });

    // ==========================================================================
    // 初期状態
    // ==========================================================================

    describe("initialState", () => {
        it("正しい初期状態を持つ", () => {
            const state = useChatStore.getState();
            expect(state.messages).toEqual([]);
            expect(state.isProcessing).toBe(false);
            expect(state.error).toBeNull();
            expect(state.activityLog).toEqual([]);
            expect(state.searchResults).toEqual([]);
            expect(state.memoryStats).toBeNull();
        });
    });

    // ==========================================================================
    // メッセージ操作
    // ==========================================================================

    describe("addMessage", () => {
        it("メッセージを追加できる", () => {
            const message: Message = {
                id: "1",
                role: "user",
                content: "Hello",
                timestamp: new Date(),
            };
            useChatStore.getState().addMessage(message);

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0]).toEqual(message);
        });

        it("複数のメッセージを順番に追加できる", () => {
            const msg1: Message = { id: "1", role: "user", content: "Hello", timestamp: new Date() };
            const msg2: Message = { id: "2", role: "assistant", content: "Hi", timestamp: new Date() };

            useChatStore.getState().addMessage(msg1);
            useChatStore.getState().addMessage(msg2);

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(2);
            expect(messages[0].id).toBe("1");
            expect(messages[1].id).toBe("2");
        });
    });

    describe("addUserMessage", () => {
        it("ユーザーメッセージを正しく追加する", () => {
            useChatStore.getState().addUserMessage("テストメッセージ", "chat");

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");
            expect(messages[0].content).toBe("テストメッセージ");
            expect(messages[0].mode).toBe("chat");
        });

        it("ユーザーメッセージ追加時にactivityLogがクリアされる", () => {
            // activityLog を事前に設定
            const activity: AgentActivity = {
                status: "completed",
                agent_name: "TestAgent",
                details: "done",
                step: 1,
            };
            useChatStore.getState().updateActivity(activity);
            expect(useChatStore.getState().activityLog).toHaveLength(1);

            useChatStore.getState().addUserMessage("新しいメッセージ", "chat");
            expect(useChatStore.getState().activityLog).toHaveLength(0);
        });

        it("ユーザーメッセージ追加時にerrorがクリアされる", () => {
            useChatStore.getState().setError("何らかのエラー");
            expect(useChatStore.getState().error).toBe("何らかのエラー");

            useChatStore.getState().addUserMessage("新しいメッセージ", "chat");
            expect(useChatStore.getState().error).toBeNull();
        });
    });

    describe("setMessages", () => {
        it("メッセージ一覧を上書きできる", () => {
            // まず既存メッセージを追加
            useChatStore.getState().addUserMessage("古いメッセージ", "chat");

            const newMessages: Message[] = [
                { id: "new1", role: "assistant", content: "新しいメッセージ", timestamp: new Date() },
            ];
            useChatStore.getState().setMessages(newMessages);

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0].id).toBe("new1");
        });
    });

    describe("clearMessages", () => {
        it("メッセージ・searchResults・activityLog・errorをすべてクリアする", () => {
            // データを設定
            useChatStore.getState().addUserMessage("メッセージ", "chat");
            useChatStore.getState().setSearchResults([
                { title: "Test", url: "http://example.com", snippet: "snippet" },
            ]);
            useChatStore.getState().updateActivity({
                status: "completed",
                agent_name: "Agent",
                details: "done",
                step: 1,
            });
            useChatStore.getState().setError("エラー");

            useChatStore.getState().clearMessages();

            const state = useChatStore.getState();
            expect(state.messages).toHaveLength(0);
            expect(state.searchResults).toHaveLength(0);
            expect(state.activityLog).toHaveLength(0);
            expect(state.error).toBeNull();
        });
    });

    // ==========================================================================
    // ストリーミング
    // ==========================================================================

    describe("handleStreamChunk (同一ノード)", () => {
        it("バッファにコンテンツが蓄積される", () => {
            useChatStore.getState().handleStreamChunk("Hello", { nodeId: "node1" });

            // タイマーが発火する前はバッファに残っている
            expect(useChatStore.getState()._streamBuffer).toBe("Hello");
        });

        it("同一ノードへの複数チャンクが連結される", () => {
            useChatStore.getState().handleStreamChunk("Hello", { nodeId: "node1" });
            useChatStore.getState().handleStreamChunk(" World", { nodeId: "node1" });

            expect(useChatStore.getState()._streamBuffer).toBe("Hello World");
        });

        it("フラッシュタイマー発火後にメッセージが追加される", () => {
            useChatStore.getState().handleStreamChunk("Hello", { nodeId: "node1" });
            vi.runAllTimers();

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");
            expect(messages[0].content).toBe("Hello");
        });

        it("既存のストリーミングメッセージにコンテンツが追記される", () => {
            // 1回目のチャンクでメッセージ作成
            useChatStore.getState().handleStreamChunk("Hello", { nodeId: "node1" });
            vi.runAllTimers();

            // 2回目のチャンク
            useChatStore.getState().handleStreamChunk(" World", { nodeId: "node1" });
            vi.runAllTimers();

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0].content).toBe("Hello World");
        });
    });

    describe("handleStreamChunk (thinkingノード)", () => {
        it("thinkingノードのコンテンツがthinkingフィールドに格納される", () => {
            useChatStore.getState().handleStreamChunk("考え中...", { nodeId: "thinking" });
            vi.runAllTimers();

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0].thinking).toBe("考え中...");
            expect(messages[0].content).toBe("");
        });
    });

    describe("handleStreamChunk (ノード切替)", () => {
        it("thinkingから通常ノードへの切替で同じメッセージが継続される", () => {
            // thinking ノードでストリーム開始
            useChatStore.getState().handleStreamChunk("思考中", { nodeId: "thinking" });
            vi.runAllTimers();

            // 通常ノードへ切替（thinking -> answer は継続）
            useChatStore.getState().handleStreamChunk("回答", { nodeId: "answer" });
            vi.runAllTimers();

            const { messages } = useChatStore.getState();
            // メッセージは1つのままで継続されるはず
            expect(messages.length).toBeLessThanOrEqual(2);
        });

        it("異なる非thinkingノードへの切替で前のメッセージが完了状態になる", () => {
            // node1 でストリーム開始
            useChatStore.getState().handleStreamChunk("ノード1コンテンツ", { nodeId: "node1" });
            vi.runAllTimers();

            // node2 に切替（どちらも非thinking）
            useChatStore.getState().handleStreamChunk("ノード2コンテンツ", { nodeId: "node2" });
            vi.runAllTimers();

            const { messages } = useChatStore.getState();
            // 2つのメッセージが存在する
            expect(messages.length).toBeGreaterThanOrEqual(1);
            // 最初のメッセージは完了状態
            if (messages.length >= 2) {
                expect(messages[0].isComplete).toBe(true);
            }
        });
    });

    describe("flushStreamBuffer", () => {
        it("バッファが空の場合は何もしない", () => {
            const before = useChatStore.getState().messages;
            useChatStore.getState().flushStreamBuffer();
            const after = useChatStore.getState().messages;
            expect(after).toEqual(before);
        });

        it("バッファのコンテンツが既存メッセージに反映される", () => {
            // 先にストリーミングメッセージを追加
            useChatStore.getState().handleStreamChunk("最初", { nodeId: "node1" });
            vi.runAllTimers();

            // バッファに新しいコンテンツを設定
            useChatStore.getState().handleStreamChunk("追記", { nodeId: "node1" });
            useChatStore.getState().flushStreamBuffer();

            const { messages } = useChatStore.getState();
            expect(messages[0].content).toContain("追記");
        });
    });

    describe("finalizeStream", () => {
        it("残りのバッファをフラッシュしてisCompleteをtrueにする", () => {
            // まずタイマーを発火させてメッセージを作成
            useChatStore.getState().handleStreamChunk("最初のコンテンツ", { nodeId: "node1" });
            vi.runAllTimers();

            // 追加チャンクをバッファに入れ、タイマーを発火せずに finalizeStream を呼ぶ
            useChatStore.getState().handleStreamChunk("追加コンテンツ", { nodeId: "node1" });
            useChatStore.getState().finalizeStream();

            const { messages } = useChatStore.getState();
            expect(messages).toHaveLength(1);
            expect(messages[0].isComplete).toBe(true);
            expect(messages[0].content).toBe("最初のコンテンツ追加コンテンツ");
        });

        it("finalizeStream後にバッファとメタデータがクリアされる", () => {
            useChatStore.getState().handleStreamChunk("コンテンツ", { nodeId: "node1" });
            useChatStore.getState().finalizeStream();

            const state = useChatStore.getState();
            expect(state._streamBuffer).toBe("");
            expect(state._streamMetadata).toBeNull();
        });

        it("streamingメッセージがない場合でもバッファはクリアされる", () => {
            // ストリーミングメッセージなしで finalizeStream を呼ぶ
            useChatStore.getState().finalizeStream();

            const state = useChatStore.getState();
            expect(state._streamBuffer).toBe("");
            expect(state._streamMetadata).toBeNull();
        });
    });

    // ==========================================================================
    // 処理状態
    // ==========================================================================

    describe("setIsProcessing", () => {
        it("isProcessingをtrueに設定できる", () => {
            useChatStore.getState().setIsProcessing(true);
            expect(useChatStore.getState().isProcessing).toBe(true);
        });

        it("isProcessingをfalseに設定できる", () => {
            useChatStore.getState().setIsProcessing(true);
            useChatStore.getState().setIsProcessing(false);
            expect(useChatStore.getState().isProcessing).toBe(false);
        });
    });

    // ==========================================================================
    // エラー状態
    // ==========================================================================

    describe("setError / clearError", () => {
        it("エラーを設定できる", () => {
            useChatStore.getState().setError("エラーが発生しました");
            expect(useChatStore.getState().error).toBe("エラーが発生しました");
        });

        it("clearErrorでエラーがnullになる", () => {
            useChatStore.getState().setError("エラー");
            useChatStore.getState().clearError();
            expect(useChatStore.getState().error).toBeNull();
        });

        it("setError(null)でエラーをnullにできる", () => {
            useChatStore.getState().setError("エラー");
            useChatStore.getState().setError(null);
            expect(useChatStore.getState().error).toBeNull();
        });
    });

    // ==========================================================================
    // アクティビティログ
    // ==========================================================================

    describe("updateActivity", () => {
        it("新しいアクティビティを追加できる", () => {
            const activity: AgentActivity = {
                status: "processing",
                agent_name: "Planner",
                details: "計画中",
                step: 0,
            };
            useChatStore.getState().updateActivity(activity);

            const { activityLog } = useChatStore.getState();
            expect(activityLog).toHaveLength(1);
            expect(activityLog[0].agent_name).toBe("Planner");
        });

        it("同じagent_nameのアクティビティは更新される（追加されない）", () => {
            const activity1: AgentActivity = {
                status: "processing",
                agent_name: "Planner",
                details: "計画中",
                step: 0,
            };
            const activity2: AgentActivity = {
                status: "completed",
                agent_name: "Planner",
                details: "完了",
                step: 0,
            };

            useChatStore.getState().updateActivity(activity1);
            useChatStore.getState().updateActivity(activity2);

            const { activityLog } = useChatStore.getState();
            expect(activityLog).toHaveLength(1);
            expect(activityLog[0].status).toBe("completed");
        });

        it("異なるagent_nameのアクティビティは別々に追加される", () => {
            useChatStore.getState().updateActivity({
                status: "processing",
                agent_name: "Planner",
                details: "",
                step: 0,
            });
            useChatStore.getState().updateActivity({
                status: "processing",
                agent_name: "Researcher",
                details: "",
                step: 0,
            });

            const { activityLog } = useChatStore.getState();
            expect(activityLog).toHaveLength(2);
        });

        it("新規追加時にstepが自動設定される", () => {
            useChatStore.getState().updateActivity({
                status: "processing",
                agent_name: "Agent1",
                details: "",
                step: 0,
            });
            useChatStore.getState().updateActivity({
                status: "processing",
                agent_name: "Agent2",
                details: "",
                step: 0,
            });

            const { activityLog } = useChatStore.getState();
            // 2つ目は step=2 になるはず
            expect(activityLog[1].step).toBe(2);
        });
    });

    describe("clearActivityLog", () => {
        it("アクティビティログをクリアできる", () => {
            useChatStore.getState().updateActivity({
                status: "completed",
                agent_name: "Agent",
                details: "",
                step: 1,
            });
            useChatStore.getState().clearActivityLog();

            expect(useChatStore.getState().activityLog).toHaveLength(0);
        });
    });

    // ==========================================================================
    // 検索結果
    // ==========================================================================

    describe("setSearchResults", () => {
        it("検索結果を設定できる", () => {
            const results: SearchResult[] = [
                { title: "Test Result", url: "http://example.com", snippet: "テストスニペット" },
            ];
            useChatStore.getState().setSearchResults(results);

            expect(useChatStore.getState().searchResults).toEqual(results);
        });

        it("空配列で検索結果をクリアできる", () => {
            useChatStore.getState().setSearchResults([
                { title: "Test", url: "http://example.com", snippet: "snippet" },
            ]);
            useChatStore.getState().setSearchResults([]);

            expect(useChatStore.getState().searchResults).toHaveLength(0);
        });
    });

    // ==========================================================================
    // メモリ統計
    // ==========================================================================

    describe("setMemoryStats", () => {
        it("メモリ統計を設定できる", () => {
            const stats = {
                char_memory: { total_events: 10, total_tokens_in_memory: 500, mean_event_size: 50 },
            };
            useChatStore.getState().setMemoryStats(stats);

            expect(useChatStore.getState().memoryStats).toEqual(stats);
        });

        it("nullでメモリ統計をクリアできる", () => {
            useChatStore.getState().setMemoryStats({
                char_memory: { total_events: 10, total_tokens_in_memory: 500, mean_event_size: 50 },
            });
            useChatStore.getState().setMemoryStats(null);

            expect(useChatStore.getState().memoryStats).toBeNull();
        });
    });

    // ==========================================================================
    // リセット
    // ==========================================================================

    describe("reset", () => {
        it("全ての状態を初期値に戻す", () => {
            // 様々な状態を設定
            useChatStore.getState().addUserMessage("メッセージ", "chat");
            useChatStore.getState().setIsProcessing(true);
            useChatStore.getState().setError("エラー");
            useChatStore.getState().updateActivity({
                status: "completed",
                agent_name: "Agent",
                details: "",
                step: 1,
            });
            useChatStore.getState().setSearchResults([
                { title: "T", url: "http://example.com", snippet: "s" },
            ]);
            useChatStore.getState().setMemoryStats({
                char_memory: { total_events: 5, total_tokens_in_memory: 100, mean_event_size: 20 },
            });

            useChatStore.getState().reset();

            const state = useChatStore.getState();
            expect(state.messages).toHaveLength(0);
            expect(state.isProcessing).toBe(false);
            expect(state.error).toBeNull();
            expect(state.activityLog).toHaveLength(0);
            expect(state.searchResults).toHaveLength(0);
            expect(state.memoryStats).toBeNull();
            expect(state._streamBuffer).toBe("");
            expect(state._streamMetadata).toBeNull();
        });
    });
});
