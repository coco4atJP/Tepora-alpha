import React from "react";
import { useTranslation } from "react-i18next";
import { LineSlider } from "../../../../shared/ui/LineSlider";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SelectionDot } from "../../../../shared/ui/SelectionDot";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { useSettingsEditor } from "../../model/editor";

const THEME_OPTIONS = [
	{ label: "System", value: "system" },
	{ label: "Tepora", value: "tepora" },
	{ label: "Light", value: "light" },
	{ label: "Dark", value: "dark" },
];

interface AppearanceSettingsProps {
	activeTab?: string;
}

export const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({
	activeTab = "Theme",
}) => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();
	const theme = editor.readString("ui.theme", "tepora");
	const fontSize = editor.readNumber("ui.font_size", 14);
	const notifications = editor.readBoolean(
		"notifications.background_task.os_notification",
		false,
	);

	if (activeTab === "Typography") {
		return (
			<SettingsSectionGroup title={t("v2.settings.typography", "Typography")}>
				<SettingsRow
					label={t("v2.settings.fontSize", "Font Size")}
					description={t(
						"v2.settings.fontSizeDescription",
						"Base font size applied to the v2 workspace.",
					)}
				>
					<LineSlider
						min={10}
						max={24}
						value={fontSize}
						onChange={(value) => editor.updateField("ui.font_size", value)}
						unit="px"
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		);
	}

	if (activeTab === "Notifications") {
		return (
			<SettingsSectionGroup title={t("v2.settings.notifications", "Notifications")}>
				<SettingsRow
					label={t("v2.settings.backgroundAlerts", "Background Alerts")}
					description={t(
						"v2.settings.backgroundAlertsDescription",
						"Use OS notifications for long-running tasks.",
					)}
				>
					<MinToggle
						checked={notifications}
						onChange={(checked) =>
							editor.updateField(
								"notifications.background_task.os_notification",
								checked,
							)
						}
						label={notifications ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		);
	}

	if (activeTab === "Code Blocks" || activeTab === "Shortcuts") {
		return (
			<SettingsSectionGroup title={activeTab}>
				<div className="rounded-[28px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
					{activeTab === "Code Blocks"
						? t(
							"v2.settings.codeBlocksPlaceholder",
							"Code block presentation options are reserved here for the next V2 pass.",
						  )
						: t(
							"v2.settings.shortcutsPlaceholder",
							"Shortcut customization will land in this tab so it does not compete with the main settings flow.",
						  )}
				</div>
			</SettingsSectionGroup>
		);
	}

	return (
		<SettingsSectionGroup title={t("v2.settings.theme", "Theme")}>
			<SettingsRow
				label={t("v2.settings.applicationTheme", "Application Theme")}
				description={t(
					"v2.settings.applicationThemeDescription",
					"Apply the selected theme immediately across the V2 workspace.",
				)}
			>
				{THEME_OPTIONS.map((option) => (
					<SelectionDot
						key={option.value}
						label={option.label}
						selected={theme === option.value}
						onClick={() => editor.updateField("ui.theme", option.value)}
					/>
				))}
			</SettingsRow>
		</SettingsSectionGroup>
	);
};
