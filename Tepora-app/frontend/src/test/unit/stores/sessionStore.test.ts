/**
 * sessionStore Unit Tests
 *
 * Tests cover:
 * - Initial state
 * - setCurrentSession
 * - setSessions / addSession / removeSession / updateSession
 * - setIsLoadingHistory
 * - resetToDefault
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSessionStore } from "../../../stores/sessionStore";
import type { Session } from "../../../types";

// ============================================================================
// Helpers
// ============================================================================

const makeSession = (id: string, title = `Session ${id}`): Session => ({
    id,
    title,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    message_count: 0,
});

const resetStore = () => {
    useSessionStore.getState().resetToDefault();
    useSessionStore.getState().setSessions([]);
};

// ============================================================================
// Tests
// ============================================================================

describe("sessionStore", () => {
    beforeEach(() => {
        resetStore();
    });

    afterEach(() => {
        resetStore();
    });

    // ==========================================================================
    // 初期状態
    // ==========================================================================

    describe("initialState", () => {
        it("デフォルトセッションIDが設定されている", () => {
            expect(useSessionStore.getState().currentSessionId).toBe("default");
        });

        it("sessions が空配列である", () => {
            expect(useSessionStore.getState().sessions).toEqual([]);
        });

        it("isLoadingHistory が false である", () => {
            expect(useSessionStore.getState().isLoadingHistory).toBe(false);
        });
    });

    // ==========================================================================
    // setCurrentSession
    // ==========================================================================

    describe("setCurrentSession", () => {
        it("currentSessionId が更新される", () => {
            useSessionStore.getState().setCurrentSession("session-001");
            expect(useSessionStore.getState().currentSessionId).toBe("session-001");
        });

        it("setCurrentSession 後に isLoadingHistory が true になる", () => {
            useSessionStore.getState().setCurrentSession("session-001");
            expect(useSessionStore.getState().isLoadingHistory).toBe(true);
        });
    });

    // ==========================================================================
    // setSessions
    // ==========================================================================

    describe("setSessions", () => {
        it("セッション一覧を上書きできる", () => {
            const sessions = [makeSession("s1"), makeSession("s2")];
            useSessionStore.getState().setSessions(sessions);

            expect(useSessionStore.getState().sessions).toEqual(sessions);
        });

        it("空配列でセッション一覧をクリアできる", () => {
            useSessionStore.getState().setSessions([makeSession("s1")]);
            useSessionStore.getState().setSessions([]);

            expect(useSessionStore.getState().sessions).toHaveLength(0);
        });
    });

    // ==========================================================================
    // addSession
    // ==========================================================================

    describe("addSession", () => {
        it("セッションを先頭に追加する", () => {
            useSessionStore.getState().setSessions([makeSession("old")]);
            useSessionStore.getState().addSession(makeSession("new"));

            const { sessions } = useSessionStore.getState();
            expect(sessions).toHaveLength(2);
            expect(sessions[0].id).toBe("new");
        });

        it("複数のセッションを順番に追加できる", () => {
            useSessionStore.getState().addSession(makeSession("s1"));
            useSessionStore.getState().addSession(makeSession("s2"));
            useSessionStore.getState().addSession(makeSession("s3"));

            const { sessions } = useSessionStore.getState();
            expect(sessions).toHaveLength(3);
            // 最後に追加したものが先頭
            expect(sessions[0].id).toBe("s3");
        });
    });

    // ==========================================================================
    // removeSession
    // ==========================================================================

    describe("removeSession", () => {
        it("指定したセッションを削除できる", () => {
            useSessionStore.getState().setSessions([makeSession("s1"), makeSession("s2"), makeSession("s3")]);
            useSessionStore.getState().removeSession("s2");

            const { sessions } = useSessionStore.getState();
            expect(sessions).toHaveLength(2);
            expect(sessions.find((s) => s.id === "s2")).toBeUndefined();
        });

        it("存在しないIDの削除は何も変えない", () => {
            useSessionStore.getState().setSessions([makeSession("s1")]);
            useSessionStore.getState().removeSession("nonexistent");

            expect(useSessionStore.getState().sessions).toHaveLength(1);
        });

        it("現在のセッションを削除するとdefaultにリセットされる", () => {
            useSessionStore.getState().setSessions([makeSession("active"), makeSession("other")]);
            useSessionStore.getState().setCurrentSession("active");
            // isLoadingHistory を一旦リセット
            useSessionStore.getState().setIsLoadingHistory(false);

            useSessionStore.getState().removeSession("active");

            expect(useSessionStore.getState().currentSessionId).toBe("default");
        });

        it("現在のセッション以外を削除してもcurrentSessionIdは変わらない", () => {
            useSessionStore.getState().setSessions([makeSession("active"), makeSession("other")]);
            useSessionStore.getState().setCurrentSession("active");
            useSessionStore.getState().setIsLoadingHistory(false);

            useSessionStore.getState().removeSession("other");

            expect(useSessionStore.getState().currentSessionId).toBe("active");
        });
    });

    // ==========================================================================
    // updateSession
    // ==========================================================================

    describe("updateSession", () => {
        it("セッションのtitleを更新できる", () => {
            useSessionStore.getState().setSessions([makeSession("s1", "旧タイトル")]);
            useSessionStore.getState().updateSession("s1", { title: "新タイトル" });

            const session = useSessionStore.getState().sessions.find((s) => s.id === "s1");
            expect(session?.title).toBe("新タイトル");
        });

        it("複数フィールドを同時に更新できる", () => {
            useSessionStore.getState().setSessions([makeSession("s1")]);
            useSessionStore.getState().updateSession("s1", {
                title: "Updated",
                message_count: 42,
            });

            const session = useSessionStore.getState().sessions.find((s) => s.id === "s1");
            expect(session?.title).toBe("Updated");
            expect(session?.message_count).toBe(42);
        });

        it("対象外のセッションは変更されない", () => {
            useSessionStore.getState().setSessions([makeSession("s1", "S1"), makeSession("s2", "S2")]);
            useSessionStore.getState().updateSession("s1", { title: "Updated S1" });

            const s2 = useSessionStore.getState().sessions.find((s) => s.id === "s2");
            expect(s2?.title).toBe("S2");
        });

        it("存在しないIDを指定した場合はセッション一覧が変化しない", () => {
            const sessions = [makeSession("s1")];
            useSessionStore.getState().setSessions(sessions);
            useSessionStore.getState().updateSession("nonexistent", { title: "ghost" });

            expect(useSessionStore.getState().sessions).toHaveLength(1);
            expect(useSessionStore.getState().sessions[0].title).toBe("Session s1");
        });
    });

    // ==========================================================================
    // setIsLoadingHistory
    // ==========================================================================

    describe("setIsLoadingHistory", () => {
        it("isLoadingHistory を true に設定できる", () => {
            useSessionStore.getState().setIsLoadingHistory(true);
            expect(useSessionStore.getState().isLoadingHistory).toBe(true);
        });

        it("isLoadingHistory を false に設定できる", () => {
            useSessionStore.getState().setIsLoadingHistory(true);
            useSessionStore.getState().setIsLoadingHistory(false);
            expect(useSessionStore.getState().isLoadingHistory).toBe(false);
        });
    });

    // ==========================================================================
    // resetToDefault
    // ==========================================================================

    describe("resetToDefault", () => {
        it("currentSessionId が 'default' にリセットされる", () => {
            useSessionStore.getState().setCurrentSession("custom-session");
            useSessionStore.getState().resetToDefault();

            expect(useSessionStore.getState().currentSessionId).toBe("default");
        });

        it("isLoadingHistory が false にリセットされる", () => {
            useSessionStore.getState().setIsLoadingHistory(true);
            useSessionStore.getState().resetToDefault();

            expect(useSessionStore.getState().isLoadingHistory).toBe(false);
        });

        it("sessions はリセット後も保持される（resetToDefaultはセッションリストを変更しない）", () => {
            useSessionStore.getState().setSessions([makeSession("s1"), makeSession("s2")]);
            useSessionStore.getState().resetToDefault();

            // resetToDefault は sessions を変更しない
            expect(useSessionStore.getState().sessions).toHaveLength(2);
        });
    });

    // ==========================================================================
    // セッション操作の組み合わせシナリオ
    // ==========================================================================

    describe("組み合わせシナリオ", () => {
        it("セッション追加 → 選択 → 別セッション追加 → 削除の流れ", () => {
            // 初期セッション追加
            useSessionStore.getState().addSession(makeSession("session-a", "チャット A"));
            useSessionStore.getState().addSession(makeSession("session-b", "チャット B"));

            // B を選択
            useSessionStore.getState().setCurrentSession("session-b");
            expect(useSessionStore.getState().currentSessionId).toBe("session-b");
            expect(useSessionStore.getState().isLoadingHistory).toBe(true);

            // ローディング完了
            useSessionStore.getState().setIsLoadingHistory(false);

            // A のタイトルを更新
            useSessionStore.getState().updateSession("session-a", { title: "チャット A（更新済）" });
            const sessionA = useSessionStore.getState().sessions.find((s) => s.id === "session-a");
            expect(sessionA?.title).toBe("チャット A（更新済）");

            // B を削除 → default にフォールバック
            useSessionStore.getState().removeSession("session-b");
            expect(useSessionStore.getState().currentSessionId).toBe("default");
            expect(useSessionStore.getState().sessions).toHaveLength(1);
        });

        it("全セッション削除後もストアが正常動作する", () => {
            useSessionStore.getState().setSessions([makeSession("only")]);
            useSessionStore.getState().setCurrentSession("only");
            useSessionStore.getState().setIsLoadingHistory(false);

            useSessionStore.getState().removeSession("only");

            expect(useSessionStore.getState().sessions).toHaveLength(0);
            expect(useSessionStore.getState().currentSessionId).toBe("default");

            // 新しいセッションを追加しても正常に動作する
            useSessionStore.getState().addSession(makeSession("new"));
            expect(useSessionStore.getState().sessions).toHaveLength(1);
        });
    });
});
