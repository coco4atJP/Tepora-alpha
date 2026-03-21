import "@testing-library/jest-dom";

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	useAgentProfiles,
	useAgentSkills,
	useSettingsConfigActions,
	useSettingsState,
} from "../../../context/SettingsContext";

describe("settings hooks", () => {
	it("throw outside SettingsProvider", () => {
		const originalError = console.error;
		console.error = vi.fn();

		expect(() => renderHook(() => useSettingsState())).toThrow(
			"useSettingsState must be used within a SettingsProvider",
		);
		expect(() => renderHook(() => useSettingsConfigActions())).toThrow(
			"useSettingsConfigActions must be used within a SettingsProvider",
		);
		expect(() => renderHook(() => useAgentSkills())).toThrow(
			"useAgentSkills must be used within a SettingsProvider",
		);
		expect(() => renderHook(() => useAgentProfiles())).toThrow(
			"useAgentProfiles must be used within a SettingsProvider",
		);

		console.error = originalError;
	});
});
