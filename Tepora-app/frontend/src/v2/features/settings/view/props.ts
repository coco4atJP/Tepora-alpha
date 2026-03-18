import type React from "react";

export interface SettingsFieldViewModel {
	id: string;
	label: string;
	description?: string;
	value: string | number | boolean | null;
	kind: "text" | "number" | "toggle" | "select";
	options?: Array<{
		label: string;
		value: string;
	}>;
}

export interface SettingsSectionViewModel {
	id: string;
	title: string;
	description?: string;
	fields: SettingsFieldViewModel[];
}

export interface SettingsScreenViewProps {
	state: "loading" | "ready" | "saving" | "error";
	sections: SettingsSectionViewModel[];
	customSectionContent?: Partial<Record<string, React.ReactNode>>;
	errorMessage: string | null;
	onFieldChange: (fieldId: string, value: string | number | boolean) => void;
	onSave: () => Promise<void>;
}
