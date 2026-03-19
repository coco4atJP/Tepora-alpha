import React from "react";
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

export const AppearanceSettings: React.FC = () => {
	const editor = useSettingsEditor();
	const theme = editor.readString("ui.theme", "tepora");
	const fontSize = editor.readNumber("ui.font_size", 14);
	const notifications = editor.readBoolean(
		"notifications.background_task.os_notification",
		false,
	);

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Theme">
				<SettingsRow label="Application Theme">
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

			<SettingsSectionGroup title="Typography">
				<SettingsRow
					label="Font Size"
					description="Base font size stored with the shared backend config"
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

			<SettingsSectionGroup title="Notifications">
				<SettingsRow
					label="Background Alerts"
					description="Persist desktop alert preference through the backend config"
				>
					<MinToggle
						checked={notifications}
						onChange={(checked) =>
							editor.updateField(
								"notifications.background_task.os_notification",
								checked,
							)
						}
						label={notifications ? "On" : "Off"}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
