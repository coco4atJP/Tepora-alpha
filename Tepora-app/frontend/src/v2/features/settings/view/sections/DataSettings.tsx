import React from "react";
import { LineSlider } from "../../../../shared/ui/LineSlider";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { useSettingsEditor } from "../../model/editor";

interface DataSettingsProps {
	activeTab?: string;
}

export const DataSettings: React.FC<DataSettingsProps> = ({
	activeTab = "Backup",
}) => {
	const editor = useSettingsEditor();
	const backupLimit = editor.readNumber("backup.startup_auto_backup_limit", 10);
	const includeHistory = editor.readBoolean("backup.include_chat_history", true);
	const includeSettings = editor.readBoolean("backup.include_settings", true);
	const includeCharacters = editor.readBoolean("backup.include_characters", true);
	const includeExecutors = editor.readBoolean("backup.include_executors", true);
	const enableRestore = editor.readBoolean("backup.enable_restore", true);
	const encryptionEnabled = editor.readBoolean("backup.encryption.enabled", false);

	if (activeTab === "Paths") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Paths">
					<SettingsRow
						label="Storage Location"
						description="Root storage path used by the backend for managed data."
					>
						<div className="text-sm text-text-muted">
							{editor.readString("storage.location", "Not configured")}
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "Indexing" || activeTab === "Cache") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title={activeTab}>
					<div className="rounded-[24px] border border-primary/10 bg-white/55 px-6 py-5 text-sm leading-7 text-text-muted">
						{activeTab === "Indexing"
							? "Indexing controls will be expanded here as the backend indexing contract is finalized."
							: "Cache maintenance actions will be exposed here in the next settings iteration."}
					</div>
				</SettingsSectionGroup>
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			<SettingsSectionGroup title="Backup">
				<SettingsRow
					label="Startup Backup Limit"
					description="Maximum number of automatic startup backups to retain"
				>
					<LineSlider
						min={1}
						max={30}
						value={backupLimit}
						onChange={(value) =>
							editor.updateField("backup.startup_auto_backup_limit", value)
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="Restore Enabled"
					description="Allow backup archives to be restored through the backend"
				>
					<MinToggle
						checked={enableRestore}
						onChange={(checked) =>
							editor.updateField("backup.enable_restore", checked)
						}
						label={enableRestore ? "Allowed" : "Blocked"}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
			<SettingsSectionGroup title="Backup Content">
				<SettingsRow label="Include Chat History">
					<MinToggle
						checked={includeHistory}
						onChange={(checked) =>
							editor.updateField("backup.include_chat_history", checked)
						}
						label={includeHistory ? "Included" : "Excluded"}
					/>
				</SettingsRow>
				<SettingsRow label="Include Settings">
					<MinToggle
						checked={includeSettings}
						onChange={(checked) =>
							editor.updateField("backup.include_settings", checked)
						}
						label={includeSettings ? "Included" : "Excluded"}
					/>
				</SettingsRow>
				<SettingsRow label="Include Characters">
					<MinToggle
						checked={includeCharacters}
						onChange={(checked) =>
							editor.updateField("backup.include_characters", checked)
						}
						label={includeCharacters ? "Included" : "Excluded"}
					/>
				</SettingsRow>
				<SettingsRow label="Include Executors">
					<MinToggle
						checked={includeExecutors}
						onChange={(checked) =>
							editor.updateField("backup.include_executors", checked)
						}
						label={includeExecutors ? "Included" : "Excluded"}
					/>
				</SettingsRow>
				<SettingsRow label="Encryption">
					<MinToggle
						checked={encryptionEnabled}
						onChange={(checked) =>
							editor.updateField("backup.encryption.enabled", checked)
						}
						label={encryptionEnabled ? "Enabled" : "Disabled"}
					/>
				</SettingsRow>
			</SettingsSectionGroup>
		</div>
	);
};
