import { useContext } from "react";
import { SettingsContext } from "../context/SettingsContext";

export function useFeatureFlag(featureName: string): boolean {
    const context = useContext(SettingsContext);
    if (!context || !context.config) return false;

    const redesignFlags = context.config.features?.redesign;
    if (!redesignFlags) return false;

    return !!redesignFlags[featureName];
}

export function useFeatureValue<T = unknown>(featureName: string): T | undefined {
    const context = useContext(SettingsContext);
    if (!context || !context.config || !context.config.features?.redesign) return undefined;

    return context.config.features.redesign[featureName] as T;
}
