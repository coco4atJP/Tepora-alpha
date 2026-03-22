import { useTranslation } from "react-i18next";
import type { SettingsEditorContextValue } from "../model/editor";
import type { NavCategory } from "./settingsLayoutConfig";
import {
	normalizeSettingsActiveTab,
	SETTINGS_SECTION_REGISTRY,
} from "./settingsSectionRegistry";

interface SettingsContentPanelProps {
	editor: SettingsEditorContextValue;
	activeCategory: NavCategory;
	activeTab: string;
}

export function SettingsContentPanel({
	editor,
	activeCategory,
	activeTab,
}: SettingsContentPanelProps) {
	const { t } = useTranslation();

	if (editor.state === "loading" && !editor.draft) {
		return (
			<div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">
				{t("v2.common.loading", "Loading...")}
			</div>
		);
	}

	if (editor.state === "error" && !editor.draft) {
		return (
			<div className="absolute inset-0 flex items-center justify-center">
				<div className="rounded-[28px] border border-red-500/20 bg-red-500/10 px-6 py-5 text-sm text-red-200">
					{editor.errorMessage ?? t("v2.settings.loadError", "Failed to load settings.")}
				</div>
			</div>
		);
	}

	const ActiveSection = SETTINGS_SECTION_REGISTRY[activeCategory];
	return (
		<ActiveSection
			activeTab={normalizeSettingsActiveTab(activeCategory, activeTab)}
		/>
	);
}
