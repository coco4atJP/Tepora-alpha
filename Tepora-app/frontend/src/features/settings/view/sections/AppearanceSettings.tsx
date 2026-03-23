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
const CODE_THEME_OPTIONS = [
	{ label: "GitHub Dark", value: "github-dark" },
	{ label: "VS Dark Plus", value: "vsc-dark-plus" },
	{ label: "One Dark", value: "one-dark" },
	{ label: "Night Owl", value: "night-owl" },
];
const FIXED_SHORTCUTS = [
	{ keys: ["Ctrl", "K"], label: "New Session / Search" },
	{ keys: ["Esc"], label: "Stop Generation / Close shortcut help" },
	{ keys: ["?"], label: "Show keyboard shortcuts" },
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
	const notificationSound = editor.readBoolean(
		"notifications.background_task.sound",
		false,
	);
	const syntaxTheme = editor.readString(
		"ui.code_block.syntax_theme",
		"github-dark",
	);
	const wrapLines = editor.readBoolean("ui.code_block.wrap_lines", true);
	const showLineNumbers = editor.readBoolean(
		"ui.code_block.show_line_numbers",
		true,
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
				<SettingsRow
					label={t("v2.settings.notificationSound", "Background Task Sound")}
					description={t(
						"v2.settings.notificationSoundDescription",
						"Play a short sound when background work finishes.",
					)}
				>
					<MinToggle
						checked={notificationSound}
						onChange={(checked) =>
							editor.updateField("notifications.background_task.sound", checked)
						}
						label={notificationSound ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		);
	}

	if (activeTab === "Code Blocks") {
		return (
			<SettingsSectionGroup title={t("v2.settings.codeBlocks", "Code Blocks")}>
				<SettingsRow
					label={t("v2.settings.codeTheme", "Code Highlight Theme")}
					description={t(
						"v2.settings.codeThemeDescription",
						"Choose the preferred syntax theme for rendered code blocks.",
					)}
				>
					{CODE_THEME_OPTIONS.map((option) => (
						<SelectionDot
							key={option.value}
							label={option.label}
							selected={syntaxTheme === option.value}
							onClick={() =>
								editor.updateField("ui.code_block.syntax_theme", option.value)
							}
						/>
					))}
				</SettingsRow>
				<SettingsRow
					label={t("v2.settings.codeWrap", "Code Block Wrap")}
					description={t(
						"v2.settings.codeWrapDescription",
						"Wrap long lines instead of forcing horizontal scrolling.",
					)}
				>
					<MinToggle
						checked={wrapLines}
						onChange={(checked) =>
							editor.updateField("ui.code_block.wrap_lines", checked)
						}
						label={wrapLines ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("v2.settings.codeLineNumbers", "Code Block Line Numbers")}
					description={t(
						"v2.settings.codeLineNumbersDescription",
						"Show line numbers alongside rendered code samples.",
					)}
				>
					<MinToggle
						checked={showLineNumbers}
						onChange={(checked) =>
							editor.updateField(
								"ui.code_block.show_line_numbers",
								checked,
							)
						}
						label={showLineNumbers ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		);
	}

	if (activeTab === "Shortcuts") {
		return (
			<SettingsSectionGroup title={t("v2.settings.shortcuts", "Shortcuts")}>
				<div className="grid gap-4 md:grid-cols-2">
					{FIXED_SHORTCUTS.map((shortcut) => (
						<div
							key={shortcut.label}
							className="rounded-[24px] border border-primary/10 bg-white/55 p-5"
						>
							<div className="text-sm font-medium text-text-main">
								{shortcut.label}
							</div>
							<div className="mt-4 flex flex-wrap gap-2">
								{shortcut.keys.map((key) => (
									<kbd
										key={key}
										className="rounded-lg border border-primary/15 bg-surface/80 px-2.5 py-1 font-mono text-xs text-text-muted"
									>
										{key}
									</kbd>
								))}
							</div>
						</div>
					))}
				</div>
				<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
					{t(
						"v2.settings.shortcutsReadonly",
						"Shortcut customization is read-only in V2 for now; this tab reflects the active built-in bindings.",
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
						label={t(`v2.settings.themes.${option.value}`, option.label)}
						selected={theme === option.value}
						onClick={() => editor.updateField("ui.theme", option.value)}
					/>
				))}
			</SettingsRow>
		</SettingsSectionGroup>
	);
};
