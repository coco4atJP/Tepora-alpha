import { useEffect } from "react";

interface ShortcutConfig {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean; // for Mac Command key
	shiftKey?: boolean;
	altKey?: boolean;
	action: (e: KeyboardEvent) => void;
	preventDefault?: boolean;
}

export const useKeyboardShortcuts = (shortcuts: ShortcutConfig[]) => {
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			for (const shortcut of shortcuts) {
				const isKeyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();
				const isCtrlMatch = !!shortcut.ctrlKey === (e.ctrlKey || e.metaKey); // Treat Ctrl and Meta (Command) interchangeably for cross-platform convenience usually, or strictly if needed.
				// However, standard specific shortcuts usually separate them.
				// For simple "Ctrl+K", checking ctrlKey || metaKey is good for "Cmd+K" on Mac.
				const isShiftMatch = !!shortcut.shiftKey === e.shiftKey;
				const isAltMatch = !!shortcut.altKey === e.altKey;

				// Special handling for '?' which requires Shift + / on many layouts,
				// but e.key usually reports '?' directly if Shift is held.
				// So if key is '?', we match.
				if (shortcut.key === "?" && e.key === "?") {
					shortcut.action(e);
					if (shortcut.preventDefault) e.preventDefault();
					return;
				}

				if (isKeyMatch && isCtrlMatch && isShiftMatch && isAltMatch) {
					if (shortcut.preventDefault) {
						e.preventDefault();
					}
					shortcut.action(e);
					return; // Execute only one shortcut per event
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [shortcuts]);
};
