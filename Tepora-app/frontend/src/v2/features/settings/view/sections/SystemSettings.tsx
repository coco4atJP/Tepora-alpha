import React from "react";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";

interface SystemSettingsProps {
	activeTab?: string;
}

export const SystemSettings: React.FC<SystemSettingsProps> = ({
	activeTab = "Integration",
}) => {
	const editor = useSettingsEditor();

	if (activeTab === "Performance") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Performance">
					<SettingsRow
						label="Process Timeout"
						description="Milliseconds to wait before forcing external loader shutdown"
					>
						<div className="w-full max-w-xs">
							<TextField
								type="number"
								value={editor.readNumber("llm_manager.process_terminate_timeout", 5000)}
								onChange={(event) =>
									editor.updateField(
										"llm_manager.process_terminate_timeout",
										Number(event.target.value) || 0,
									)
								}
								min={1}
							/>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "Updates") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Updates">
					<SettingsRow
						label="Auto Update"
						description="Allow Tepora to check for app and runtime updates."
					>
						<MinToggle
							checked={editor.readBoolean("system.auto_update", true)}
							onChange={(checked) => editor.updateField("system.auto_update", checked)}
							label={editor.readBoolean("system.auto_update", true) ? "Enabled" : "Disabled"}
						/>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Integration">
				<SettingsRow
					label="Start on Login"
					description="Launch Tepora automatically when the desktop session starts."
				>
					<MinToggle
						checked={editor.readBoolean("system.auto_start", false)}
						onChange={(checked) => editor.updateField("system.auto_start", checked)}
						label={editor.readBoolean("system.auto_start", false) ? "Enabled" : "Disabled"}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
