import { readNestedValue, type SettingsRecord } from "./configUtils";

export interface SettingsEditorReaders {
	readString: (path: string, fallback?: string) => string;
	readNumber: (path: string, fallback?: number) => number;
	readBoolean: (path: string, fallback?: boolean) => boolean;
	readStringList: (path: string, fallback?: string[]) => string[];
}

export function buildSettingsEditorReaders(
	draft: SettingsRecord | null,
): SettingsEditorReaders {
	return {
		readString: (path: string, fallback = "") => {
			const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
			return typeof valueAtPath === "string" ? valueAtPath : fallback;
		},
		readNumber: (path: string, fallback = 0) => {
			const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
			return typeof valueAtPath === "number" ? valueAtPath : fallback;
		},
		readBoolean: (path: string, fallback = false) => {
			const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
			return typeof valueAtPath === "boolean" ? valueAtPath : fallback;
		},
		readStringList: (path: string, fallback: string[] = []) => {
			const valueAtPath = draft ? readNestedValue(draft, path) : undefined;
			return Array.isArray(valueAtPath)
				? valueAtPath.filter((item): item is string => typeof item === "string")
				: fallback;
		},
	};
}
