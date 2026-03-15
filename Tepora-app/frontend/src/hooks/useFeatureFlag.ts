import { useSettingsState } from "../context/SettingsContext";

export function useFeatureFlag(featureName: string): boolean {
    const { config } = useSettingsState();
    if (!config) return false;

    const redesignFlags = config.features?.redesign;
    if (!redesignFlags) return false;

    return !!redesignFlags[featureName];
}

export function useFeatureValue<T = unknown>(featureName: string): T | undefined {
    const { config } = useSettingsState();
    if (!config?.features?.redesign) return undefined;

    return config.features.redesign[featureName] as T;
}
