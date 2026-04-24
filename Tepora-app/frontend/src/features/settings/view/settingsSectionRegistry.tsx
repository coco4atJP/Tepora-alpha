import type { ComponentType } from "react";
import { AdvancedSettings } from "./sections/AdvancedSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { AgentsSettings } from "./sections/AgentsSettings";
import { CapabilitiesSettings } from "./sections/CapabilitiesSettings";
import { ContextSettings } from "./sections/ContextSettings";
import { DataSettings } from "./sections/DataSettings";
import { GeneralSettings } from "./sections/GeneralSettings";
import { MemorySettings } from "./sections/MemorySettings";
import { ModelsSettings } from "./sections/ModelsSettings";
import { PrivacySettings } from "./sections/PrivacySettings";
import { SystemSettings } from "./sections/SystemSettings";
import type { NavCategory } from "./settingsLayoutConfig";

interface SettingsSectionProps {
	activeTab: string;
}

type SettingsSectionComponent = ComponentType<SettingsSectionProps>;

export const SETTINGS_SECTION_REGISTRY: Record<NavCategory, SettingsSectionComponent> = {
	General: GeneralSettings,
	Appearance: AppearanceSettings,
	Privacy: PrivacySettings,
	Data: DataSettings,
	System: SystemSettings,
	Models: ModelsSettings,
	Memory: MemorySettings,
	Context: ContextSettings,
	Agents: AgentsSettings,
	Capabilities: CapabilitiesSettings,
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
