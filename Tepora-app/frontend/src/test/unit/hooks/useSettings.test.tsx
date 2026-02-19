import { renderHook } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { SettingsContext, type SettingsContextValue } from "../../../context/SettingsContext";
import { useSettings } from "../../../hooks/useSettings";

describe("useSettings", () => {
	it("throws error when used outside of SettingsProvider", () => {
		// Suppress console.error for this test as React logs the error
		const originalError = console.error;
		console.error = vi.fn();

		expect(() => renderHook(() => useSettings())).toThrow(
			"useSettings must be used within a SettingsProvider",
		);

		console.error = originalError;
	});

	it("returns context value when used within SettingsProvider", () => {
		const mockContextValue: SettingsContextValue = {
			config: null,
			originalConfig: null,
			customAgents: {},
			loading: false,
			error: null,
			hasChanges: false,
			saving: false,
			fetchConfig: vi.fn(),
			updateApp: vi.fn(),
			updateLlmManager: vi.fn(),
			updateChatHistory: vi.fn(),
			updateEmLlm: vi.fn(),
			updateModel: vi.fn(),
			updateTools: vi.fn(),
			updatePrivacy: vi.fn(),
			updateSearch: vi.fn(),
			updateModelDownload: vi.fn(),
			updateServer: vi.fn(),
			updateLoaderBaseUrl: vi.fn(),
			updateCharacter: vi.fn(),
			addCharacter: vi.fn(),
			deleteCharacter: vi.fn(),
			updateCustomAgent: vi.fn(),
			addCustomAgent: vi.fn(),
			deleteCustomAgent: vi.fn(),
			setActiveAgent: vi.fn(),
			saveConfig: vi.fn(),
			resetConfig: vi.fn(),
		};

		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<SettingsContext.Provider value={mockContextValue}>{children}</SettingsContext.Provider>
		);

		const { result } = renderHook(() => useSettings(), { wrapper });
		expect(result.current).toBe(mockContextValue);
	});
});
