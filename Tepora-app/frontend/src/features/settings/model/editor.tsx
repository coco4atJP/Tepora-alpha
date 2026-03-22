import {
	createContext,
	useContext,
	type ReactNode,
} from "react";
import type { SettingsEditorContextValue } from "./settingsEditorTypes";
import { useSettingsEditorModel } from "./useSettingsEditorModel";

const SettingsEditorContext = createContext<SettingsEditorContextValue | null>(null);

export function SettingsEditorProvider({
	children,
}: {
	children: ReactNode;
}) {
	const value = useSettingsEditorModel();

	return (
		<SettingsEditorContext.Provider value={value}>
			{children}
		</SettingsEditorContext.Provider>
	);
}

export function useSettingsEditor() {
	const context = useContext(SettingsEditorContext);
	if (!context) {
		throw new Error("useSettingsEditor must be used within SettingsEditorProvider");
	}
	return context;
}

export { readNestedValue } from "./configUtils";
export type { SettingsEditorContextValue } from "./settingsEditorTypes";
