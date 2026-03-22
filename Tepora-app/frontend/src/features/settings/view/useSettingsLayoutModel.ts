import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsEditorContextValue } from "../model/editor";
import {
	SETTINGS_CATEGORIES,
	type NavCategory,
} from "./settingsLayoutConfig";

interface UseSettingsLayoutModelParams {
	editor: SettingsEditorContextValue;
	onClose: () => void;
}

export function useSettingsLayoutModel({
	editor,
	onClose,
}: UseSettingsLayoutModelParams) {
	const { t } = useTranslation();
	const [activeCategory, setActiveCategory] = useState<NavCategory>("General");
	const [activeTab, setActiveTab] = useState<string>("Basics");

	useEffect(() => {
		const category = SETTINGS_CATEGORIES.find((item) => item.id === activeCategory);
		if (category && !category.tabs.includes(activeTab)) {
			setActiveTab(category.tabs[0]);
		}
	}, [activeCategory, activeTab]);

	useEffect(() => {
		if (!editor.hasUnsavedChanges || editor.state === "saving") {
			return;
		}

		const timeoutId = window.setTimeout(() => {
			void editor.save();
		}, 450);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [editor]);

	const activeCategoryObj = useMemo(
		() => SETTINGS_CATEGORIES.find((item) => item.id === activeCategory),
		[activeCategory],
	);

	const footerMessage = editor.errorMessage
		? editor.errorMessage
		: editor.state === "saving"
			? t("v2.settings.saving", "Saving changes...")
			: editor.hasUnsavedChanges
				? t("v2.settings.pendingSave", "Saving soon...")
				: t("v2.settings.allSaved", "All changes saved automatically");

	const handleClose = () => {
		if (editor.hasUnsavedChanges && editor.state !== "saving") {
			void editor.save();
		}
		onClose();
	};

	return {
		activeCategory,
		setActiveCategory,
		activeTab,
		setActiveTab,
		activeCategoryObj,
		footerMessage,
		handleClose,
	};
}
