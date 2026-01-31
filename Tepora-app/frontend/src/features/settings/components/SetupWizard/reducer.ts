import type { DefaultModelsResponse, ModelConfig, SetupAction, SetupState } from "./types";

export const initialState: SetupState = {
	step: "LANGUAGE",
	language: "en",
	loader: "llama_cpp",
	requirements: null,
	defaults: null,
	selectedModels: new Set(),
	customModels: null,
	progress: { status: "idle", progress: 0, message: "" },
	error: null,
	jobId: null,
};

/** Generate unique key for model */
export const getKey = (m: ModelConfig) => `${m.repo_id}:${m.filename}`;

/** Get default selected models from defaults response */
const getDefaultSelectedModels = (defaults: DefaultModelsResponse): Set<string> => {
	const recommended = new Set<string>();
	if (defaults.text_models.length > 0) {
		recommended.add(getKey(defaults.text_models[0]));
		if (defaults.text_models.length > 1) {
			recommended.add(getKey(defaults.text_models[1]));
		}
	}
	return recommended;
};

export function setupReducer(state: SetupState, action: SetupAction): SetupState {
	switch (action.type) {
		case "SET_LANGUAGE":
			return { ...state, language: action.payload, step: "LOADER_SELECT" };

		case "SET_LOADER":
			return { ...state, loader: action.payload };

		case "REQ_CHECK_START":
			return { ...state, step: "CHECK_REQUIREMENTS", error: null };

		case "REQ_CHECK_SUCCESS":
			return {
				...state,
				requirements: action.payload,
				step: action.payload.is_ready ? "COMPLETE" : "MODEL_CONFIG",
			};

		case "REQ_CHECK_FAILURE":
			return {
				...state,
				step: "ERROR",
				error: action.payload,
			};

		case "GOTO_CONFIG":
			return { ...state, step: "MODEL_CONFIG" };

		case "SET_DEFAULTS":
			return {
				...state,
				defaults: action.payload,
				selectedModels: getDefaultSelectedModels(action.payload),
			};

		case "TOGGLE_MODEL": {
			const newSet = new Set(state.selectedModels);
			if (newSet.has(action.payload)) {
				newSet.delete(action.payload);
			} else {
				newSet.add(action.payload);
			}
			return { ...state, selectedModels: newSet };
		}

		case "SET_CUSTOM_MODELS":
			return { ...state, customModels: action.payload };

		case "START_INSTALL":
			return {
				...state,
				step: "INSTALLING",
				jobId: action.payload,
				error: null,
				progress: { status: "pending", progress: 0, message: "Starting..." },
			};

		case "UPDATE_PROGRESS":
			return { ...state, progress: action.payload };

		case "INSTALL_SUCCESS":
			return { ...state, step: "COMPLETE", jobId: null };

		case "INSTALL_FAILURE":
			return { ...state, step: "ERROR", error: action.payload, jobId: null };

		case "RESET_ERROR":
			return { ...state, step: "CHECK_REQUIREMENTS", error: null };

		default:
			return state;
	}
}
