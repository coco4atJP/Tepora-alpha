import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "../../../hooks/useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
    it("executes action on matching key press", () => {
        const action = vi.fn();
        renderHook(() =>
            useKeyboardShortcuts([
                {
                    key: "k",
                    ctrlKey: true,
                    action,
                },
            ]),
        );

        fireEvent.keyDown(window, { key: "k", ctrlKey: true });
        expect(action).toHaveBeenCalled();
    });

    it("does not execute action on mismatch", () => {
        const action = vi.fn();
        renderHook(() =>
            useKeyboardShortcuts([
                {
                    key: "k",
                    ctrlKey: true,
                    action,
                },
            ]),
        );

        fireEvent.keyDown(window, { key: "k", ctrlKey: false });
        expect(action).not.toHaveBeenCalled();
    });

    it("prevents default if configured", () => {
        const action = vi.fn();
        renderHook(() =>
            useKeyboardShortcuts([
                {
                    key: "s",
                    ctrlKey: true,
                    action,
                    preventDefault: true,
                },
            ]),
        );

        const event = new KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            cancelable: true,
        });
        const preventDefaultSpy = vi.spyOn(event, "preventDefault");

        // fireEvent creates a synthetic event, we can try to inspect call on mock
        // manually dispatching for spy
        window.dispatchEvent(event);

        expect(action).toHaveBeenCalled();
        expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it("handles ? shortcut specifically", () => {
        const action = vi.fn();
        renderHook(() =>
            useKeyboardShortcuts([
                {
                    key: "?",
                    action,
                },
            ]),
        );

        fireEvent.keyDown(window, { key: "?" });
        expect(action).toHaveBeenCalled();
    });
});
