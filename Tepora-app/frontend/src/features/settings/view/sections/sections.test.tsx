import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdvancedSettings } from "./AdvancedSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { DataSettings } from "./DataSettings";

const updateField = vi.fn();

const STRING_VALUES: Record<string, string> = {
	"ui.code_block.syntax_theme": "github-dark",
	"server.host": "127.0.0.1",
};

const NUMBER_VALUES: Record<string, number> = {
	"cache.capacity_limit_mb": 512,
	"storage.chunk_size_chars": 1200,
	"storage.chunk_size_tokens": 256,
	"storage.chunk_overlap": 64,
};

const BOOLEAN_VALUES: Record<string, boolean> = {
	"ui.code_block.wrap_lines": true,
	"ui.code_block.show_line_numbers": true,
	"cache.webfetch_clear_on_startup": false,
	"cache.cleanup_old_embeddings": false,
	"cache.cleanup_temp_files": true,
	"model_download.require_allowlist": true,
	"model_download.warn_on_unlisted": true,
	"model_download.require_revision": true,
	"model_download.require_sha256": true,
};

const STRING_LIST_VALUES: Record<string, string[]> = {
	"model_download.allow_repo_owners": ["trusted-owner"],
	"server.allowed_origins": ["http://localhost:1420"],
	"server.cors_allowed_origins": ["http://localhost:1420"],
	"server.ws_allowed_origins": ["http://localhost:1420"],
};

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback?: string) => fallback ?? _key,
	}),
}));

vi.mock("../../model/editor", () => ({
	useSettingsEditor: () => ({
		draft: null,
		readString: (path: string, fallback = "") => STRING_VALUES[path] ?? fallback,
		readNumber: (path: string, fallback = 0) => NUMBER_VALUES[path] ?? fallback,
		readBoolean: (path: string, fallback = false) => BOOLEAN_VALUES[path] ?? fallback,
		readStringList: (path: string, fallback: string[] = []) =>
			STRING_LIST_VALUES[path] ?? fallback,
		updateField,
	}),
}));

describe("settings sections", () => {
	beforeEach(() => {
		updateField.mockReset();
	});

	it("renders concrete controls for appearance code blocks", () => {
		render(<AppearanceSettings activeTab="Code Blocks" />);

		expect(screen.getByText("Code Highlight Theme")).toBeInTheDocument();
		expect(screen.getByText("Code Block Wrap")).toBeInTheDocument();
		expect(screen.getByText("Code Block Line Numbers")).toBeInTheDocument();
		expect(
			screen.queryByText(
				"Code block presentation options are reserved here for the next V2 pass.",
			),
		).not.toBeInTheDocument();
	});

	it("updates data cache capacity through a concrete input", () => {
		render(<DataSettings activeTab="Cache" />);

		fireEvent.change(screen.getByDisplayValue("512"), {
			target: { value: "1024" },
		});

		expect(updateField).toHaveBeenCalledWith("cache.capacity_limit_mb", 1024);
	});

	it("updates advanced server host through a concrete input", () => {
		render(<AdvancedSettings activeTab="Server" />);

		fireEvent.change(screen.getByDisplayValue("127.0.0.1"), {
			target: { value: "0.0.0.0" },
		});

		expect(updateField).toHaveBeenCalledWith("server.host", "0.0.0.0");
	});
});
