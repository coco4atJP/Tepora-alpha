import {
	readNestedValue,
	setNestedValue,
	type SettingsRecord,
} from "./configUtils";

export type EditorStatus = "loading" | "ready" | "saving" | "error";

export interface SettingsEditorState {
	baseline: SettingsRecord | null;
	draft: SettingsRecord | null;
	dirtyFields: string[];
	status: EditorStatus;
	errorMessage: string | null;
}

export type SettingsEditorAction =
	| { type: "HYDRATE"; config: SettingsRecord }
	| { type: "FIELD_CHANGED"; fieldId: string; value: unknown }
	| { type: "SAVE_STARTED" }
	| { type: "SAVE_SUCCEEDED" }
	| { type: "SAVE_FAILED"; message: string }
	| { type: "RESET" };

export function createInitialSettingsEditorState(): SettingsEditorState {
	return {
		baseline: null,
		draft: null,
		dirtyFields: [],
		status: "loading",
		errorMessage: null,
	};
}

export function settingsEditorReducer(
	state: SettingsEditorState,
	action: SettingsEditorAction,
): SettingsEditorState {
	switch (action.type) {
		case "HYDRATE":
			return {
				...state,
				baseline: action.config,
				draft: action.config,
				dirtyFields: [],
				status: "ready",
				errorMessage: null,
			};
		case "FIELD_CHANGED": {
			if (!state.draft || !state.baseline) {
				return state;
			}

			const nextDraft = setNestedValue(
				state.draft,
				action.fieldId,
				action.value,
			) as SettingsRecord;
			const baselineValue = readNestedValue(state.baseline, action.fieldId);
			const nextDirtyFields = areValuesEqual(baselineValue, action.value)
				? state.dirtyFields.filter((fieldId) => fieldId !== action.fieldId)
				: Array.from(new Set([...state.dirtyFields, action.fieldId]));

			return {
				...state,
				draft: nextDraft,
				dirtyFields: nextDirtyFields,
				status: "ready",
				errorMessage: null,
			};
		}
		case "SAVE_STARTED":
			return {
				...state,
				status: "saving",
				errorMessage: null,
			};
		case "SAVE_SUCCEEDED":
			return {
				...state,
				baseline: state.draft,
				dirtyFields: [],
				status: "ready",
				errorMessage: null,
			};
		case "SAVE_FAILED":
			return {
				...state,
				status: "error",
				errorMessage: action.message,
			};
		case "RESET":
			return {
				...state,
				draft: state.baseline,
				dirtyFields: [],
				status: "ready",
				errorMessage: null,
			};
		default:
			return state;
	}
}

function areValuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
