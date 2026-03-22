import type { ComponentType } from "react";
import { AdvancedSettings } from "./sections/AdvancedSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { CharactersSettings } from "./sections/CharactersSettings";
import { ContextSettings } from "./sections/ContextSettings";
import { DataSettings } from "./sections/DataSettings";
import { GeneralSettings } from "./sections/GeneralSettings";
import { MemorySettings } from "./sections/MemorySettings";
import { ModelsSettings } from "./sections/ModelsSettings";
import { PrivacySettings } from "./sections/PrivacySettings";
import { SystemSettings } from "./sections/SystemSettings";
import { ToolsSettings } from "./sections/ToolsSettings";
import type { NavCategory } from "./settingsLayoutConfig";

interface SettingsSectionProps {
	activeTab: string;
}

type SettingsSectionComponent = ComponentType<SettingsSectionProps>;

export const SETTINGS_SECTION_REGISTRY: Record<NavCategory, SettingsSectionComponent> = {
	General: GeneralSettings,
	Appearance: AppearanceSettings,
	Characters: CharactersSettings,
	Models: ModelsSettings,
	Privacy: PrivacySettings,
	Tools: ToolsSettings,
	Memory: MemorySettings,
	Context: ContextSettings,
	Data: DataSettings,
	System: SystemSettings,
	Advanced: AdvancedSettings,
};

export function normalizeSettingsActiveTab(
	category: NavCategory,
	activeTab: string,
): string {
	if (category === "General" && activeTab === "Deliberate") {
		return "Thinking";
	}

	return activeTab;
}
