import { useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsScreenViewWrapperProps } from "../view/SettingsScreenView";
import { useSaveV2ConfigMutation, useV2ConfigQuery } from "./queries";
import {
	buildConfigPatch,
	buildSettingsSections,
	createInitialSettingsEditorState,
	normalizeConfigForEditor,
	settingsEditorReducer,
} from "./state";

interface UseSettingsScreenModelOptions {
	isOpen: boolean;
	onClose: () => void;
}

export function useSettingsScreenModel({
	isOpen,
	onClose,
}: UseSettingsScreenModelOptions): SettingsScreenViewWrapperProps {
	const { i18n } = useTranslation();
	const configQuery = useV2ConfigQuery();
	const saveMutation = useSaveV2ConfigMutation();
	const [state, dispatch] = useReducer(
		settingsEditorReducer,
		undefined,
		createInitialSettingsEditorState,
	);

	useEffect(() => {
		if (!configQuery.data || state.dirtyFields.length > 0) {
			return;
		}

		dispatch({
			type: "HYDRATE",
			config: normalizeConfigForEditor(configQuery.data),
		});
	}, [configQuery.data, state.dirtyFields.length]);

	const sections = state.draft ? buildSettingsSections(state.draft) : [];

	return {
		isOpen,
		onClose,
		activeSectionId: state.activeSectionId,
		onSectionChange: (sectionId) => {
			dispatch({
				type: "SECTION_CHANGED",
				sectionId:
					sectionId === "appearance" ||
					sectionId === "agents" ||
					sectionId === "advanced"
						? sectionId
						: "general",
			});
		},
		state:
			state.status === "saving"
				? "saving"
				: configQuery.isLoading && !state.draft
					? "loading"
					: configQuery.error
						? "error"
						: state.status === "error"
							? "error"
							: "ready",
		sections,
		errorMessage:
			state.errorMessage ??
			(configQuery.error instanceof Error ? configQuery.error.message : null),
		onFieldChange: (fieldId, value) => {
			dispatch({
				type: "FIELD_CHANGED",
				fieldId,
				value,
			});
		},
		onSave: async () => {
			if (!state.draft || state.dirtyFields.length === 0) {
				return;
			}

			dispatch({ type: "SAVE_STARTED" });
			try {
				const patch = buildConfigPatch(state.draft, state.dirtyFields);
				await saveMutation.mutateAsync(patch);
				if (state.draft.app.language) {
					await i18n.changeLanguage(state.draft.app.language);
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
	};
}
