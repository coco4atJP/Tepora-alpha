import { HardDrive } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../../../hooks/useSettings";
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

const DataStorageSettings: React.FC = () => {
    const { t } = useTranslation();
    const { config, updateConfigPath } = useSettings();

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

    return (
        <div className="space-y-6">
            <SettingsSection
                title={t("settings.sections.extended.storage_title", "Data Management and Storage")}
                icon={<HardDrive size={18} />}
                description={t(
                    "settings.sections.extended.storage_description",
                    "Configure chunking, watched folders, storage paths, backups, and cache policies.",
                )}
            >
                <div className="space-y-4">
                    <FormGroup
                        label={t("settings.sections.extended.chunk_chars", "Chunk Size (Chars)")}
                        description={t(
                            "settings.sections.extended.chunk_chars_desc",
                            "Chunk size when indexing text by character count.",
                        )}
                    >
                        <FormInput
                            type="number"
                            value={readNumber("storage.chunk_size_chars", 0)}
                            onChange={(value) => updateConfigPath("storage.chunk_size_chars", value)}
                            min={0}
                            step={100}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.chunk_tokens", "Chunk Size (Tokens)")}
                        description={t(
                            "settings.sections.extended.chunk_tokens_desc",
                            "Chunk size when indexing text by token count.",
                        )}
                    >
                        <FormInput
                            type="number"
                            value={readNumber("storage.chunk_size_tokens", 0)}
                            onChange={(value) => updateConfigPath("storage.chunk_size_tokens", value)}
                            min={0}
                            step={32}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.chunk_overlap", "Chunk Overlap")}
                        description={t(
                            "settings.sections.extended.chunk_overlap_desc",
                            "Overlap size between consecutive chunks.",
                        )}
                    >
                        <FormInput
                            type="number"
                            value={readNumber("storage.chunk_overlap", 0)}
                            onChange={(value) => updateConfigPath("storage.chunk_overlap", value)}
                            min={0}
                            step={16}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.export_format", "Backup Export Format")}
                        description={t(
                            "settings.sections.extended.export_format_desc",
                            "Preferred format for backup exports.",
                        )}
                    >
                        <FormSelect
                            value={readString("backup.export_format", "json")}
                            onChange={(value) => updateConfigPath("backup.export_format", value)}
                            options={[
                                { value: "json", label: "JSON" },
                                { value: "sqlite_dump", label: "SQLite dump" },
                            ]}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.watch_folders", "Watched Folders")}
                        description={t(
                            "settings.sections.extended.watch_folders_desc",
                            "Folders monitored for indexing targets.",
                        )}
                        orientation="vertical"
                    >
                        <FormList
                            items={readStringList("storage.watch_folders")}
                            onChange={(items) => updateConfigPath("storage.watch_folders", items)}
                            placeholder={t("settings.sections.extended.watch_folders_placeholder", "e.g. D:\\docs")}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.vector_store_dir", "Vector Store Directory")}
                        description={t(
                            "settings.sections.extended.vector_store_dir_desc",
                            "Storage path for vector database files.",
                        )}
                    >
                        <FormInput
                            value={readString("storage.vector_store_dir", "")}
                            onChange={(value) => updateConfigPath("storage.vector_store_dir", value)}
                            placeholder={t("settings.sections.extended.vector_store_dir_placeholder", "e.g. E:\\Tepora\\db")}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.model_files_dir", "Model Files Directory")}
                        description={t(
                            "settings.sections.extended.model_files_dir_desc",
                            "Storage path for model binaries.",
                        )}
                    >
                        <FormInput
                            value={readString("storage.model_files_dir", "")}
                            onChange={(value) => updateConfigPath("storage.model_files_dir", value)}
                            placeholder={t("settings.sections.extended.model_files_dir_placeholder", "e.g. E:\\Tepora\\models")}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.backup_chat_history", "Backup: Chat History")}
                    >
                        <FormSwitch
                            checked={readBoolean("backup.include_chat_history", true)}
                            onChange={(value) => updateConfigPath("backup.include_chat_history", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.backup_settings", "Backup: Settings Data")}
                    >
                        <FormSwitch
                            checked={readBoolean("backup.include_settings", true)}
                            onChange={(value) => updateConfigPath("backup.include_settings", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.backup_characters", "Backup: Characters")}
                    >
                        <FormSwitch
                            checked={readBoolean("backup.include_characters", true)}
                            onChange={(value) => updateConfigPath("backup.include_characters", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.backup_executors", "Backup: Executors")}
                    >
                        <FormSwitch
                            checked={readBoolean("backup.include_executors", true)}
                            onChange={(value) => updateConfigPath("backup.include_executors", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.restore_enabled", "Enable Backup Restore")}
                    >
                        <FormSwitch
                            checked={readBoolean("backup.enable_restore", true)}
                            onChange={(value) => updateConfigPath("backup.enable_restore", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.character_import_export", "Character Import/Export")}
                    >
                        <FormSwitch
                            checked={readBoolean("backup.character_import_export", true)}
                            onChange={(value) => updateConfigPath("backup.character_import_export", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.executor_import_export", "Executor Import/Export")}
                    >
                        <FormSwitch
                            checked={readBoolean("backup.executor_import_export", true)}
                            onChange={(value) => updateConfigPath("backup.executor_import_export", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.cache_clear_on_start", "Clear Webfetch Cache on Startup")}
                    >
                        <FormSwitch
                            checked={readBoolean("cache.webfetch_clear_on_startup", false)}
                            onChange={(value) => updateConfigPath("cache.webfetch_clear_on_startup", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.cache_cleanup_embeddings", "Cleanup Old Embeddings")}
                    >
                        <FormSwitch
                            checked={readBoolean("cache.cleanup_old_embeddings", false)}
                            onChange={(value) => updateConfigPath("cache.cleanup_old_embeddings", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.cache_cleanup_temp", "Cleanup Temporary Files")}
                    >
                        <FormSwitch
                            checked={readBoolean("cache.cleanup_temp_files", false)}
                            onChange={(value) => updateConfigPath("cache.cleanup_temp_files", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.cache_limit_mb", "Cache Capacity Limit (MB)")}
                    >
                        <FormInput
                            type="number"
                            value={readNumber("cache.capacity_limit_mb", 0)}
                            onChange={(value) => updateConfigPath("cache.capacity_limit_mb", value)}
                            min={0}
                            step={128}
                        />
                    </FormGroup>
                </div>
            </SettingsSection>
        </div>
    );
};

export default DataStorageSettings;
