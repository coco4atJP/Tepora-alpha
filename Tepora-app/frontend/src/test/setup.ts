import "@testing-library/jest-dom";
import type React from "react";
import { vi } from "vitest";

// Common translations used in tests
const translations: Record<string, string> = {
	// Chat Input
	"chat.input.send_message": "Send Message",
	"chat.input.stop_generation": "Stop Generation",
	"chat.input.aria_label": "Chat Input",
	"chat.input.placeholder.default": "Type a message...",
	"chat.input.placeholder.connecting": "Connecting...",
	"chat.input.placeholder.search": "Search...",
	"chat.input.placeholder.agent": "Ask agent...",
	"chat.input.system_ready": "System Ready",
	"chat.input.disconnected": "Disconnected",
	"chat.input.remove_attachment": "Remove attachment",
	"chat.input.attach_file": "Attach file",
	"chat.input.web_search": "Web Search",
	"chat.input.web_search_toggle": "Toggle web search",
	"chat.input.stop": "Stop",
	"chat.input.send": "Send",
	"chat.input.mode_active": "Active",

	// Common
	"common.clear": "Clear",
	"common.settings": "Settings",
	"common.close": "Close",
	"common.error": "Error",
	newSession: "New Session",

	// Search Results
	"searchResults.title": "Search Results",
	"searchResults.empty": "No results found",
	"search.no_results": "検索結果待機中...",
	"search.hits": "results",
	"search.title": "Search Results",

	// Personas
	"personas.switch": "Switch Persona",
};

// Mock react-i18next
vi.mock("react-i18next", () => ({
	// this mock makes sure any components using the translate hook can use it without a warning being shown
	useTranslation: () => ({
		t: (key: string, defaultValue?: string) => translations[key] || defaultValue || key,
		i18n: {
			changeLanguage: () => new Promise(() => {}),
			language: "en",
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock WebSocket
class MockWebSocket {
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	send = vi.fn();
	close = vi.fn();
	readyState = 0;
	constructor(public url: string) {}
}

globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
};
