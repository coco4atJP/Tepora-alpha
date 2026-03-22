import { useEffect } from "react";
import type { V2Config } from "../../../shared/contracts";
import { normalizeConfigForEditor } from "./configUtils";
import type { SettingsEditorAction } from "./settingsEditorState";

interface UseSettingsEditorHydrationParams {
	config: V2Config | undefined;
	dirtyFieldCount: number;
	dispatch: React.Dispatch<SettingsEditorAction>;
}

export function useSettingsEditorHydration({
	config,
	dirtyFieldCount,
	dispatch,
}: UseSettingsEditorHydrationParams) {
	useEffect(() => {
		if (!config || dirtyFieldCount > 0) {
			return;
		}

		dispatch({
			type: "HYDRATE",
			config: normalizeConfigForEditor(config),
		});
	}, [config, dirtyFieldCount, dispatch]);
}
