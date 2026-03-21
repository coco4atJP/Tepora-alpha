import React from "react";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";
import { useTranslation } from "react-i18next";

interface SystemSettingsProps {
	activeTab?: string;
}

export const SystemSettings: React.FC<SystemSettingsProps> = ({
	activeTab = "Integration",
}) => {
	const { t } = useTranslation();
	const editor = useSettingsEditor();

	if (activeTab === "Performance") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title={t("v2.settings.performance", "Performance")}>
					<SettingsRow
						label={t("v2.settings.processTimeout", "Process Timeout")}
						description={t("v2.settings.processTimeoutDescription", "Milliseconds to wait before forcing external loader shutdown")}
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
				<SettingsSectionGroup title={t("v2.settings.updates", "Updates")}>
					<SettingsRow
						label={t("v2.settings.autoUpdate", "Auto Update")}
						description={t("v2.settings.autoUpdateDescription", "Allow Tepora to check for app and runtime updates.")}
					>
						<MinToggle
							checked={editor.readBoolean("system.auto_update", true)}
							onChange={(checked) => editor.updateField("system.auto_update", checked)}
							label={editor.readBoolean("system.auto_update", true) ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
						/>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title={t("v2.settings.integration", "Integration")}>
				<SettingsRow
					label={t("v2.settings.startOnLogin", "Start on Login")}
					description={t("v2.settings.startOnLoginDescription", "Launch Tepora automatically when the desktop session starts.")}
				>
					<MinToggle
						checked={editor.readBoolean("system.auto_start", false)}
						onChange={(checked) => editor.updateField("system.auto_start", checked)}
						label={editor.readBoolean("system.auto_start", false) ? t("v2.common.enabled", "Enabled") : t("v2.common.disabled", "Disabled")}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
