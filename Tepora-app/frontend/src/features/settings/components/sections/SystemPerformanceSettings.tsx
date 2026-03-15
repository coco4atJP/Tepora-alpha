import { Cpu } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSettingsConfigActions, useSettingsState } from "../../../../context/SettingsContext";
import { FormGroup, FormInput, FormSwitch, SettingsSection } from "../SettingsComponents";

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

const SystemPerformanceSettings: React.FC = () => {
    const { t } = useTranslation();
    const { config } = useSettingsState();
    const { updateConfigPath } = useSettingsConfigActions();

    if (!config) return null;

    const readNumber = (path: string, fallback = 0) => {
        const value = getPathValue<unknown>(config, path, fallback);
        return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    };

    const readBoolean = (path: string, fallback = false) => {
        const value = getPathValue<unknown>(config, path, fallback);
        return typeof value === "boolean" ? value : fallback;
    };

    return (
        <div className="space-y-6">
            <SettingsSection
                title={t("settings.sections.extended.performance_title", "System Integration and Performance")}
                icon={<Cpu size={18} />}
                description={t(
                    "settings.sections.extended.performance_description",
                    "Control startup behavior, tray mode, hardware acceleration, and resource limits.",
                )}
            >
                <div className="space-y-4">
                    <FormGroup
                        label={t("settings.sections.extended.auto_start", "Auto Start on OS Login")}
                    >
                        <FormSwitch
                            checked={readBoolean("system.auto_start", false)}
                            onChange={(value) => updateConfigPath("system.auto_start", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.tray_resident", "Keep Running in System Tray")}
                    >
                        <FormSwitch
                            checked={readBoolean("system.tray_resident", false)}
                            onChange={(value) => updateConfigPath("system.tray_resident", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.hardware_acceleration", "Hardware Acceleration")}
                    >
                        <FormSwitch
                            checked={readBoolean("system.hardware_acceleration", true)}
                            onChange={(value) => updateConfigPath("system.hardware_acceleration", value)}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.gpu_vram_limit", "GPU VRAM Limit (MB)")}
                    >
                        <FormInput
                            type="number"
                            value={readNumber("performance.gpu_vram_limit_mb", 0)}
                            onChange={(value) => updateConfigPath("performance.gpu_vram_limit_mb", value)}
                            min={0}
                            step={256}
                        />
                    </FormGroup>

                    <FormGroup
                        label={t("settings.sections.extended.memory_limit", "Memory Limit (MB)")}
                    >
                        <FormInput
                            type="number"
                            value={readNumber("performance.memory_limit_mb", 0)}
                            onChange={(value) => updateConfigPath("performance.memory_limit_mb", value)}
                            min={0}
                            step={256}
                        />
                    </FormGroup>
                </div>
            </SettingsSection>
        </div>
    );
};

export default SystemPerformanceSettings;
