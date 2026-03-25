import { useCallback, useEffect, useState } from "react";
import { useSetupStore } from "./setupStore";
import {
	useRefreshLmStudioMutation,
	useRefreshOllamaMutation,
	useRequirementsQuery,
	useSetupDefaultModelsQuery,
} from "./setupQueries";
import type { SetupPattern, InternetPreference } from "./setupTypes";

export function useSetupOrchestrator() {
	const internetPreference = useSetupStore((state) => state.internetPreference);
	const { data: requirements, refetch: refetchRequirements } = useRequirementsQuery();
	const { data: defaultModels } = useSetupDefaultModelsQuery();
	
	const { mutateAsync: refreshOllama } = useRefreshOllamaMutation();
	const { mutateAsync: refreshLmStudio } = useRefreshLmStudioMutation();

	const [pattern, setPattern] = useState<SetupPattern | null>(null);
	const [isChecking, setIsChecking] = useState(false);

	const runSystemCheck = useCallback(async (internet: InternetPreference) => {
		setIsChecking(true);
		
		try {
			// 1. Refresh external runtimes
			await Promise.allSettled([
				refreshOllama(),
				refreshLmStudio()
			]);
			
			// 2. Get latest requirements state
			const { data: reqs } = await refetchRequirements();
			if (!reqs) return;

			// 3. Analyze state
			// Backend `requirements` implicitly checks if any active/ready models exist.
			// But for our specialized flow, we need to know specifically if we have 
			// an external runtime (ollama/lmstudio) and an embedding model.
			// The default setup models list will tell us what's active.
			const activeTextModels = defaultModels?.models.filter(m => 
				m.is_active && m.role !== "embedding"
			) ?? [];
			
			const activeEmbeddingModels = defaultModels?.models.filter(m => 
				m.is_active && m.role === "embedding"
			) ?? [];

			const hasExternalRuntime = activeTextModels.some(m => 
				m.loader === "ollama" || m.loader === "lmstudio" || 
				m.file_path?.startsWith("ollama://") || m.file_path?.startsWith("lmstudio://")
			);
			const hasEmbedding = activeEmbeddingModels.length > 0;

			// 4. Match patterns precisely mapping to the plan
			let detectedPattern: SetupPattern;
			if (internet === "on") {
				if (hasExternalRuntime) {
					if (hasEmbedding) {
						detectedPattern = "A_READY";
					} else {
						detectedPattern = "C_DOWNLOAD_EMBED";
					}
				} else {
					detectedPattern = "B_DOWNLOAD_ALL";
				}
			} else { // internet === "off"
				if (hasExternalRuntime) {
					detectedPattern = "E_OFFLINE_READY";
				} else {
					detectedPattern = "D_OFFLINE_NO_RUN";
				}
			}
			setPattern(detectedPattern);
		} finally {
			setIsChecking(false);
		}
	}, [refreshOllama, refreshLmStudio, refetchRequirements, defaultModels]);

	// Auto-run system check if preference is present but pattern is not resolved
	useEffect(() => {
		if (internetPreference && !pattern && !isChecking && defaultModels) {
			void runSystemCheck(internetPreference);
		}
	}, [internetPreference, pattern, isChecking, defaultModels, runSystemCheck]);

	return {
		pattern,
		isChecking,
		runSystemCheck,
		requirements,
		defaultModels,
	};
}
