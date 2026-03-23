import React from "react";
import { LineSlider } from "../../../../shared/ui/LineSlider";
import { MinToggle } from "../../../../shared/ui/MinToggle";
import { Select } from "../../../../shared/ui/Select";
import { SettingsRow } from "../../../../shared/ui/SettingsRow";
import { SettingsSectionGroup } from "../../../../shared/ui/SettingsSectionGroup";
import { TextField } from "../../../../shared/ui/TextField";
import { useSettingsEditor } from "../../model/editor";

function parseLineList(value: string): string[] {
	return value
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
}

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
	const exportFormat = editor.readString("backup.export_format", "json");
	const storageLocation = editor.readString("storage.location", "");
	const vectorStoreDir = editor.readString("storage.vector_store_dir", "");
	const modelFilesDir = editor.readString("storage.model_files_dir", "");
	const watchedFolders = editor.readStringList("storage.watch_folders", []);
	const chunkSizeChars = editor.readNumber("storage.chunk_size_chars", 0);
	const chunkSizeTokens = editor.readNumber("storage.chunk_size_tokens", 0);
	const chunkOverlap = editor.readNumber("storage.chunk_overlap", 0);
	const clearWebfetchCache = editor.readBoolean(
		"cache.webfetch_clear_on_startup",
		false,
	);
	const cleanupEmbeddings = editor.readBoolean(
		"cache.cleanup_old_embeddings",
		false,
	);
	const cleanupTempFiles = editor.readBoolean(
		"cache.cleanup_temp_files",
		false,
	);
	const cacheCapacityLimitMb = editor.readNumber("cache.capacity_limit_mb", 0);

	if (activeTab === "Paths") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Paths">
					<SettingsRow
						label="Storage Location"
						description="Root storage path used by the backend for managed data."
					>
						<div className="w-full max-w-xl">
							<TextField
								value={storageLocation}
								onChange={(event) =>
									editor.updateField("storage.location", event.target.value)
								}
								placeholder="Not configured"
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="Vector Store Directory"
						description="Directory used to persist vector database artifacts."
					>
						<div className="w-full max-w-xl">
							<TextField
								value={vectorStoreDir}
								onChange={(event) =>
									editor.updateField(
										"storage.vector_store_dir",
										event.target.value,
									)
								}
								placeholder="/absolute/path/to/vector-store"
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="Model Files Directory"
						description="Preferred directory for downloaded or managed model files."
					>
						<div className="w-full max-w-xl">
							<TextField
								value={modelFilesDir}
								onChange={(event) =>
									editor.updateField(
										"storage.model_files_dir",
										event.target.value,
									)
								}
								placeholder="/absolute/path/to/models"
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="Watched Folders"
						description="One folder per line. These folders are monitored as indexing targets."
					>
						<div className="w-full max-w-2xl">
							<textarea
								value={watchedFolders.join("\n")}
								onChange={(event) =>
									editor.updateField(
										"storage.watch_folders",
										parseLineList(event.target.value),
									)
								}
								className="min-h-[140px] w-full rounded-md border border-border bg-surface px-3 py-2 font-sans text-sm text-text-main transition-colors duration-200 ease-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
								placeholder={"/path/to/docs\n/path/to/projects"}
							/>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "Indexing") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Indexing">
					<SettingsRow
						label="Chunk Size (Chars)"
						description="Chunk size when indexing text by character count."
					>
						<div className="w-full max-w-xs">
							<TextField
								type="number"
								value={chunkSizeChars}
								onChange={(event) =>
									editor.updateField(
										"storage.chunk_size_chars",
										Number(event.target.value) || 0,
									)
								}
								min={0}
								step={100}
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="Chunk Size (Tokens)"
						description="Chunk size when indexing text by token count."
					>
						<div className="w-full max-w-xs">
							<TextField
								type="number"
								value={chunkSizeTokens}
								onChange={(event) =>
									editor.updateField(
										"storage.chunk_size_tokens",
										Number(event.target.value) || 0,
									)
								}
								min={0}
								step={32}
							/>
						</div>
					</SettingsRow>
					<SettingsRow
						label="Chunk Overlap"
						description="Overlap size between consecutive indexed chunks."
					>
						<div className="w-full max-w-xs">
							<TextField
								type="number"
								value={chunkOverlap}
								onChange={(event) =>
									editor.updateField(
										"storage.chunk_overlap",
										Number(event.target.value) || 0,
									)
								}
								min={0}
								step={16}
							/>
						</div>
					</SettingsRow>
				</SettingsSectionGroup>
			</div>
		);
	}

	if (activeTab === "Cache") {
		return (
			<div className="flex flex-col">
				<SettingsSectionGroup title="Cache">
					<SettingsRow
						label="Clear Webfetch Cache on Startup"
						description="Remove cached fetch responses whenever the app starts."
					>
						<MinToggle
							checked={clearWebfetchCache}
							onChange={(checked) =>
								editor.updateField("cache.webfetch_clear_on_startup", checked)
							}
							label={clearWebfetchCache ? "Enabled" : "Disabled"}
						/>
					</SettingsRow>
					<SettingsRow
						label="Cleanup Old Embeddings"
						description="Allow cleanup of stale embedding cache entries."
					>
						<MinToggle
							checked={cleanupEmbeddings}
							onChange={(checked) =>
								editor.updateField("cache.cleanup_old_embeddings", checked)
							}
							label={cleanupEmbeddings ? "Enabled" : "Disabled"}
						/>
					</SettingsRow>
					<SettingsRow
						label="Cleanup Temporary Files"
						description="Purge temporary working files during maintenance passes."
					>
						<MinToggle
							checked={cleanupTempFiles}
							onChange={(checked) =>
								editor.updateField("cache.cleanup_temp_files", checked)
							}
							label={cleanupTempFiles ? "Enabled" : "Disabled"}
						/>
					</SettingsRow>
					<SettingsRow
						label="Cache Capacity Limit (MB)"
						description="Soft capacity target for managed caches."
					>
						<div className="w-full max-w-xs">
							<TextField
								type="number"
								value={cacheCapacityLimitMb}
								onChange={(event) =>
									editor.updateField(
										"cache.capacity_limit_mb",
										Number(event.target.value) || 0,
									)
								}
								min={0}
								step={128}
							/>
						</div>
					</SettingsRow>
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
				<SettingsRow
					label="Backup Export Format"
					description="Preferred archive format for backup exports."
				>
					<div className="w-full max-w-sm">
						<Select
							value={exportFormat}
							onChange={(event) =>
								editor.updateField("backup.export_format", event.target.value)
							}
						>
							<option value="json">JSON</option>
							<option value="sqlite_dump">SQLite dump</option>
						</Select>
					</div>
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
