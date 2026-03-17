import { describe, expect, it } from "vitest";
import type { V2Config } from "../../../shared/contracts";
import {
	buildConfigPatch,
	createInitialSettingsEditorState,
	normalizeConfigForEditor,
	settingsEditorReducer,
} from "./state";

const baseConfig: V2Config = normalizeConfigForEditor({
	app: {
		language: "ja",
		max_input_length: 2048,
		nsfw_enabled: false,
		setup_completed: true,
		tool_execution_timeout: 90_000,
		graph_execution_timeout: 120_000,
	},
	active_agent_profile: "default",
	tools: {
		search_provider: "duckduckgo",
	},
	privacy: {
		allow_web_search: true,
		redact_pii: true,
	},
	thinking: {
		chat_default: false,
		search_default: true,
	},
	features: {
		redesign: {
			frontend_logging: false,
			transport_mode: "websocket",
		},
	},
});

describe("settingsEditorReducer", () => {
	it("tracks dirty fields and clears them when values return to baseline", () => {
		let state = createInitialSettingsEditorState();
		state = settingsEditorReducer(state, {
			type: "HYDRATE",
			config: baseConfig,
		});
		state = settingsEditorReducer(state, {
			type: "FIELD_CHANGED",
			fieldId: "app.language",
			value: "en",
		});

		expect(state.dirtyFields).toEqual(["app.language"]);

		state = settingsEditorReducer(state, {
			type: "FIELD_CHANGED",
			fieldId: "app.language",
			value: "ja",
		});

		expect(state.dirtyFields).toEqual([]);
	});
});

describe("buildConfigPatch", () => {
	it("builds a nested PATCH payload from dirty field ids", () => {
		const patch = buildConfigPatch(baseConfig, [
			"app.language",
			"privacy.allow_web_search",
			"features.redesign.transport_mode",
		]);

		expect(patch).toEqual({
			app: {
				language: "ja",
			},
			privacy: {
				allow_web_search: true,
			},
			features: {
				redesign: {
					transport_mode: "websocket",
				},
			},
		});
	});
});
