import type { SetupModel } from "../../../shared/contracts";
import type { SettingsRecord } from "./configUtils";
import type { EditorStatus } from "./settingsEditorState";

export interface SettingsEditorContextValue {
	state: EditorStatus;
	errorMessage: string | null;
	hasUnsavedChanges: boolean;
	isModelUpdating: boolean;
	draft: SettingsRecord | null;
	textModels: SetupModel[];
	embeddingModels: SetupModel[];
	activeTextModelId: string | null;
	activeEmbeddingModelId: string | null;
	isSaving: boolean;
	readString: (path: string, fallback?: string) => string;
	readNumber: (path: string, fallback?: number) => number;
	readBoolean: (path: string, fallback?: boolean) => boolean;
	readStringList: (path: string, fallback?: string[]) => string[];
	updateField: (path: string, value: unknown) => void;
	save: () => Promise<void>;
	reset: () => void;
	activateModel: (modelId: string, role: "text" | "embedding") => Promise<void>;
}
