import { useMemo, useReducer } from "react";
import { useTranslation } from "react-i18next";
import {
	buildConfigPatch,
	readNestedValue,
} from "./configUtils";
import { buildSettingsEditorReaders } from "./settingsEditorReaders";
import {
	createInitialSettingsEditorState,
	settingsEditorReducer,
} from "./settingsEditorState";
import type { SettingsEditorContextValue } from "./settingsEditorTypes";
import { useSettingsEditorHydration } from "./useSettingsEditorHydration";
import { useSettingsEditorQueries } from "./useSettingsEditorQueries";

export function useSettingsEditorModel(): SettingsEditorContextValue {
	const { i18n } = useTranslation();
	const {
		configQuery,
		saveMutation,
		setActiveModelMutation,
		textModels,
		embeddingModels,
		activeTextModelId,
		activeEmbeddingModelId,
	} = useSettingsEditorQueries();
	const [state, dispatch] = useReducer(
		settingsEditorReducer,
		undefined,
		createInitialSettingsEditorState,
	);

	useSettingsEditorHydration({
		config: configQuery.data,
		dirtyFieldCount: state.dirtyFields.length,
		dispatch,
	});

	return useMemo<SettingsEditorContextValue>(() => {
		const draft = state.draft;
		const readers = buildSettingsEditorReaders(draft);

		return {
			state:
				state.status === "saving"
					? "saving"
					: configQuery.isLoading && !draft
						? "loading"
						: configQuery.error
							? "error"
							: state.status,
			errorMessage:
				state.errorMessage ??
				(configQuery.error instanceof Error ? configQuery.error.message : null),
			hasUnsavedChanges: state.dirtyFields.length > 0,
			isModelUpdating: setActiveModelMutation.isPending,
			draft,
			textModels,
			embeddingModels,
			activeTextModelId,
			activeEmbeddingModelId,
			isSaving: saveMutation.isPending,
			...readers,
			updateField: (path, fieldValue) => {
				dispatch({
					type: "FIELD_CHANGED",
					fieldId: path,
					value: fieldValue,
				});
			},
			save: async () => {
				if (!state.draft || state.dirtyFields.length === 0) {
					return;
				}

				dispatch({ type: "SAVE_STARTED" });
				try {
					const patch = buildConfigPatch(state.draft, state.dirtyFields);
					await saveMutation.mutateAsync(patch);
					const nextLanguage = readNestedValue(state.draft, "app.language");
					if (typeof nextLanguage === "string" && nextLanguage.length > 0) {
						void i18n.changeLanguage(nextLanguage);
					}
					dispatch({ type: "SAVE_SUCCEEDED" });
				} catch (error) {
					dispatch({
						type: "SAVE_FAILED",
						message:
							error instanceof Error ? error.message : "Failed to save settings",
					});
				}
			},
			reset: () => {
				dispatch({ type: "RESET" });
			},
			activateModel: async (modelId, assignmentKey) => {
				try {
					await setActiveModelMutation.mutateAsync({
						model_id: modelId,
						assignment_key: assignmentKey,
					});
				} catch (error) {
					dispatch({
						type: "SAVE_FAILED",
						message:
							error instanceof Error ? error.message : "Failed to update model",
					});
				}
			},
		};
	}, [
		activeEmbeddingModelId,
		activeTextModelId,
		configQuery.error,
		configQuery.isLoading,
		embeddingModels,
		i18n,
		saveMutation,
		setActiveModelMutation,
		state,
		textModels,
	]);
}
