import { useContext } from "react";
import {
	SettingsContext,
	type SettingsContextValue,
} from "../context/SettingsContext";

/**
 * Hook to access settings context.
 * Must be used within a SettingsProvider.
 */
export function useSettings(): SettingsContextValue {
	const context = useContext(SettingsContext);
	if (!context) {
		throw new Error("useSettings must be used within a SettingsProvider");
	}
	return context;
}
