import { HardDrive, Upload, Download, Shield } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../components/ui/Button";
import { useSettings } from "../../../../hooks/useSettings";
import type { BackupEnvelope, BackupExportPayload, BackupImportResult } from "../../../../types";
import { apiClient } from "../../../../utils/api-client";
import { ENDPOINTS } from "../../../../utils/endpoints";
import {
    FormGroup,
    FormInput,
    FormList,
    FormSelect,
    FormSwitch,
    SettingsSection,
} from "../SettingsComponents";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPathValue<T>(source: unknown, path: string, fallback: T): T {
    const keys = path.split(".").filter(Boolean);
    let current: unknown = source;

    for (const key of keys) {
        if (!isRecord(current)) return fallback;
        current = current[key];
    }

    if (current === undefined || current === null) return fallback;
    return current as T;
}

const formatTimestamp = (value?: string | null) => value ? new Date(value).toLocaleString() : "-";

const DataStorageSettings: React.FC = () => {
    const { t } = useTranslation();
    const { config, updateConfigPath } = useSettings();
    const [exportPassphrase, setExportPassphrase] = useState("");
    const [exportBusy, setExportBusy] = useState(false);
    const [exportMessage, setExportMessage] = useState<string | null>(null);
    const [importPassphrase, setImportPassphrase] = useState("");
    const [importStage, setImportStage] = useState("verify");
    const [importJson, setImportJson] = useState("");
    const [importBusy, setImportBusy] = useState(false);
    const [importResult, setImportResult] = useState<BackupImportResult | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    if (!config) return null;

    const readString = (path: string, fallback = "") => {
        const value = getPathValue<unknown>(config, path, fallback);
        return typeof value === "string" ? value : fallback;
    };

    const readNumber = (path: string, fallback = 0) => {
        const value = getPathValue<unknown>(config, path, fallback);
        return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    };

    const readBoolean = (path: string, fallback = false) => {
        const value = getPathValue<unknown>(config, path, fallback);
        return typeof value === "boolean" ? value : fallback;
    };

    const readStringList = (path: string) => {
        const value = getPathValue<unknown>(config, path, []);
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    };

    const downloadBackup = (payload: BackupExportPayload) => {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = payload.filename || "tepora-backup.json";
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const extractEnvelope = (raw: string): BackupEnvelope => {
        const parsed = JSON.parse(raw) as unknown;
        if (isRecord(parsed) && typeof parsed.version === "number") {
            return parsed as unknown as BackupEnvelope;
        }
        if (isRecord(parsed) && isRecord(parsed.archive) && typeof parsed.archive.version === "number") {
            return parsed.archive as unknown as BackupEnvelope;
        }
        if (
            isRecord(parsed) &&
            isRecord(parsed.archive) &&
            isRecord(parsed.archive.archive) &&
            typeof parsed.archive.archive.version === "number"
        ) {
            return parsed.archive.archive as unknown as BackupEnvelope;
        }
        throw new Error("Invalid backup JSON format");
    };

    const handleExport = async () => {
        if (!exportPassphrase.trim()) {
            setExportMessage(t("settings.backup.passphrase_required", "A passphrase is required for encrypted backup export."));
            return;
        }
        setExportBusy(true);
        setExportMessage(null);
        try {
            const response = await apiClient.post<{ success: boolean; archive: BackupExportPayload }>(
                ENDPOINTS.BACKUP.EXPORT,
                {
                    passphrase: exportPassphrase,
                    include_chat_history: readBoolean("backup.include_chat_history", true),
                    include_settings: readBoolean("backup.include_settings", true),
                    include_characters: readBoolean("backup.include_characters", true),
                    include_executors: readBoolean("backup.include_executors", true),
                },
            );
            downloadBackup(response.archive);
            setExportMessage(t("settings.backup.export_done", "Encrypted backup exported."));
        } catch (error) {
            console.error("Failed to export backup", error);
            setExportMessage(t("settings.backup.export_failed", "Failed to export encrypted backup."));
        } finally {
            setExportBusy(false);
        }
    };

    const handleImport = async () => {
        if (!importPassphrase.trim() || !importJson.trim()) {
            return;
        }
        setImportBusy(true);
        try {
            const archive = extractEnvelope(importJson);
            const response = await apiClient.post<{ success: boolean; result: BackupImportResult }>(
                ENDPOINTS.BACKUP.IMPORT,
                {
                    passphrase: importPassphrase,
                    archive,
                    stage: importStage,
                },
            );
            setImportResult(response.result);
        } catch (error) {
            console.error("Failed to import backup", error);
            setImportResult(null);
        } finally {
            setImportBusy(false);
        }
    };

    const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        setImportJson(text);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    return (
        <div className="space-y-6">
            <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />

            <SettingsSection
                title={t("settings.sections.extended.storage_title", "Data Management and Storage")}
                icon={<HardDrive size={18} />}
                description={t("settings.sections.extended.storage_description", "Configure chunking, watched folders, storage paths, backups, and cache policies.")}
            >
                <div className="space-y-4">
                    <FormGroup label={t("settings.sections.extended.chunk_chars", "Chunk Size (Chars)")} description={t("settings.sections.extended.chunk_chars_desc", "Chunk size when indexing text by character count.")}>
                        <FormInput type="number" value={readNumber("storage.chunk_size_chars", 0)} onChange={(value) => updateConfigPath("storage.chunk_size_chars", value)} min={0} step={100} />
                    </FormGroup>

                    <FormGroup label={t("settings.sections.extended.chunk_tokens", "Chunk Size (Tokens)")} description={t("settings.sections.extended.chunk_tokens_desc", "Chunk size when indexing text by token count.")}>
                        <FormInput type="number" value={readNumber("storage.chunk_size_tokens", 0)} onChange={(value) => updateConfigPath("storage.chunk_size_tokens", value)} min={0} step={32} />
                    </FormGroup>

                    <FormGroup label={t("settings.sections.extended.chunk_overlap", "Chunk Overlap")} description={t("settings.sections.extended.chunk_overlap_desc", "Overlap size between consecutive chunks.")}>
                        <FormInput type="number" value={readNumber("storage.chunk_overlap", 0)} onChange={(value) => updateConfigPath("storage.chunk_overlap", value)} min={0} step={16} />
                    </FormGroup>

                    <FormGroup label={t("settings.sections.extended.export_format", "Backup Export Format")} description={t("settings.sections.extended.export_format_desc", "Preferred format for backup exports.")}>
                        <FormSelect
                            value={readString("backup.export_format", "json")}
                            onChange={(value) => updateConfigPath("backup.export_format", value)}
                            options={[
                                { value: "json", label: "JSON" },
                                { value: "sqlite_dump", label: "SQLite dump" },
                            ]}
                        />
                    </FormGroup>

                    <FormGroup label={t("settings.sections.extended.watch_folders", "Watched Folders")} description={t("settings.sections.extended.watch_folders_desc", "Folders monitored for indexing targets.")} orientation="vertical">
                        <FormList items={readStringList("storage.watch_folders")} onChange={(items) => updateConfigPath("storage.watch_folders", items)} placeholder={t("settings.sections.extended.watch_folders_placeholder", "e.g. D:\\docs")} />
                    </FormGroup>

                    <FormGroup label={t("settings.sections.extended.vector_store_dir", "Vector Store Directory")} description={t("settings.sections.extended.vector_store_dir_desc", "Storage path for vector database files.")}>
                        <FormInput value={readString("storage.vector_store_dir", "")} onChange={(value) => updateConfigPath("storage.vector_store_dir", value)} placeholder={t("settings.sections.extended.vector_store_dir_placeholder", "e.g. E:\\Tepora\\db")} />
                    </FormGroup>

                    <FormGroup label={t("settings.sections.extended.model_files_dir", "Model Files Directory")} description={t("settings.sections.extended.model_files_dir_desc", "Storage path for model binaries.")}>
                        <FormInput value={readString("storage.model_files_dir", "")} onChange={(value) => updateConfigPath("storage.model_files_dir", value)} placeholder={t("settings.sections.extended.model_files_dir_placeholder", "e.g. E:\\Tepora\\models")} />
                    </FormGroup>

                    <FormGroup label={t("settings.sections.extended.backup_chat_history", "Backup: Chat History")}>
                        <FormSwitch checked={readBoolean("backup.include_chat_history", true)} onChange={(value) => updateConfigPath("backup.include_chat_history", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.backup_settings", "Backup: Settings Data")}>
                        <FormSwitch checked={readBoolean("backup.include_settings", true)} onChange={(value) => updateConfigPath("backup.include_settings", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.backup_characters", "Backup: Characters")}>
                        <FormSwitch checked={readBoolean("backup.include_characters", true)} onChange={(value) => updateConfigPath("backup.include_characters", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.backup_executors", "Backup: Executors")}>
                        <FormSwitch checked={readBoolean("backup.include_executors", true)} onChange={(value) => updateConfigPath("backup.include_executors", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.restore_enabled", "Enable Backup Restore")}>
                        <FormSwitch checked={readBoolean("backup.enable_restore", true)} onChange={(value) => updateConfigPath("backup.enable_restore", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.character_import_export", "Character Import/Export")}>
                        <FormSwitch checked={readBoolean("backup.character_import_export", true)} onChange={(value) => updateConfigPath("backup.character_import_export", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.executor_import_export", "Executor Import/Export")}>
                        <FormSwitch checked={readBoolean("backup.executor_import_export", true)} onChange={(value) => updateConfigPath("backup.executor_import_export", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.cache_clear_on_start", "Clear Webfetch Cache on Startup")}>
                        <FormSwitch checked={readBoolean("cache.webfetch_clear_on_startup", false)} onChange={(value) => updateConfigPath("cache.webfetch_clear_on_startup", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.cache_cleanup_embeddings", "Cleanup Old Embeddings")}>
                        <FormSwitch checked={readBoolean("cache.cleanup_old_embeddings", false)} onChange={(value) => updateConfigPath("cache.cleanup_old_embeddings", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.cache_cleanup_temp", "Cleanup Temporary Files")}>
                        <FormSwitch checked={readBoolean("cache.cleanup_temp_files", false)} onChange={(value) => updateConfigPath("cache.cleanup_temp_files", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.sections.extended.cache_limit_mb", "Cache Capacity Limit (MB)")}>
                        <FormInput type="number" value={readNumber("cache.capacity_limit_mb", 0)} onChange={(value) => updateConfigPath("cache.capacity_limit_mb", value)} min={0} step={128} />
                    </FormGroup>
                </div>
            </SettingsSection>

            <SettingsSection
                title={t("settings.backup.encrypted.title", "Encrypted Backup and Restore")}
                icon={<Shield size={18} />}
                description={t("settings.backup.encrypted.description", "Export encrypted backup archives and verify or restore them in three stages.")}
            >
                <div className="space-y-4">
                    <FormGroup label={t("settings.backup.encryption.enabled", "Encryption enabled")} description={t("settings.backup.encryption.enabled_desc", "Marks encrypted backup flow as the default path in settings.")}>
                        <FormSwitch checked={readBoolean("backup.encryption.enabled", true)} onChange={(value) => updateConfigPath("backup.encryption.enabled", value)} />
                    </FormGroup>
                    <FormGroup label={t("settings.backup.encryption.hint", "Passphrase hint")} description={t("settings.backup.encryption.hint_desc", "Optional local hint shown next to the encryption setting.")}>
                        <FormInput value={readString("backup.encryption.hint", "")} onChange={(value) => updateConfigPath("backup.encryption.hint", value)} placeholder={t("settings.backup.encryption.hint_placeholder", "e.g. stored in offline vault") } />
                    </FormGroup>

                    <div className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-4">
                        <div>
                            <h4 className="text-sm font-semibold text-white">{t("settings.backup.export.title", "Export encrypted backup")}</h4>
                            <p className="text-xs text-gray-400 mt-1">{t("settings.backup.export.desc", "Uses the selected backup scope toggles above and downloads a JSON archive.")}</p>
                        </div>
                        <FormGroup label={t("settings.backup.passphrase", "Passphrase")} description={t("settings.backup.passphrase_desc", "Required to encrypt and later restore the archive.")}>
                            <FormInput type="password" value={exportPassphrase} onChange={(value) => setExportPassphrase(String(value))} placeholder="********" />
                        </FormGroup>
                        <div className="flex items-center gap-3">
                            <Button variant="primary" onClick={() => void handleExport()} isLoading={exportBusy} icon={<Download size={16} />}>
                                {t("settings.backup.export.action", "Export archive")}
                            </Button>
                            {exportMessage && <span className="text-sm text-gray-300">{exportMessage}</span>}
                        </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-4">
                        <div>
                            <h4 className="text-sm font-semibold text-white">{t("settings.backup.import.title", "Import encrypted backup")}</h4>
                            <p className="text-xs text-gray-400 mt-1">{t("settings.backup.import.desc", "Run verify, dry-run compatibility checks, or apply the restore.")}</p>
                        </div>
                        <div className="flex flex-wrap gap-3">
                            <Button variant="secondary" onClick={() => fileInputRef.current?.click()} icon={<Upload size={16} />}>
                                {t("settings.backup.import.file", "Load backup JSON")}
                            </Button>
                            <FormSelect
                                value={importStage}
                                onChange={setImportStage}
                                options={[
                                    { value: "verify", label: t("settings.backup.stage.verify", "Verify") },
                                    { value: "dry_run", label: t("settings.backup.stage.dry_run", "Dry Run") },
                                    { value: "apply", label: t("settings.backup.stage.apply", "Apply") },
                                ]}
                            />
                        </div>
                        <FormGroup label={t("settings.backup.passphrase", "Passphrase")}>
                            <FormInput type="password" value={importPassphrase} onChange={(value) => setImportPassphrase(String(value))} placeholder="********" />
                        </FormGroup>
                        <FormGroup label={t("settings.backup.import.payload", "Backup JSON")} description={t("settings.backup.import.payload_desc", "Paste the exported JSON or load it from file.")} orientation="vertical">
                            <textarea
                                value={importJson}
                                onChange={(event) => setImportJson(event.target.value)}
                                className="settings-input glass-input min-h-[180px] w-full font-mono text-xs"
                                placeholder="{ ... backup json ... }"
                            />
                        </FormGroup>
                        <Button variant="primary" onClick={() => void handleImport()} isLoading={importBusy}>
                            {t("settings.backup.import.action", "Run import stage")}
                        </Button>
                        {importResult && (
                            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-200 space-y-1">
                                <div>{t("settings.backup.import.stage_result", "Stage")}: {importResult.stage}</div>
                                <div>{t("settings.backup.import.sessions", "Sessions")}: {importResult.sessions}</div>
                                <div>{t("settings.backup.import.applied", "Applied")}: {importResult.applied ? "yes" : "no"}</div>
                                <div>{t("settings.backup.import.exported_at", "Exported at")}: {formatTimestamp(importResult.manifest.exported_at)}</div>
                                <div>{t("settings.backup.import.schema", "Schema")}: {importResult.manifest.schema_version}</div>
                            </div>
                        )}
                    </div>
                </div>
            </SettingsSection>
        </div>
    );
};

export default DataStorageSettings;

