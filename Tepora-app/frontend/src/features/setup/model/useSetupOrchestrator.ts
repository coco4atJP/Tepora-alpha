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
	const [checkError, setCheckError] = useState<string | null>(null);

	const runSystemCheck = useCallback(async (internet: InternetPreference) => {
		setIsChecking(true);
		setCheckError(null);
		
		const timeoutPromise = new Promise((_, reject) => 
			setTimeout(() => reject(new Error("Analysis timed out after 30 seconds")), 30000)
		);

		try {
			// 1. Refresh external runtimes (with internal timeout)
			await Promise.race([
				Promise.allSettled([
					refreshOllama(),
					refreshLmStudio()
				]),
				timeoutPromise
			]);
			
			// 2. Get latest requirements state
			const { data: reqs } = await refetchRequirements();
			if (!reqs) return;

			// 3. Analyze state
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
		} catch (err) {
			console.error("System check failed or timed out", err);
			setCheckError(err instanceof Error ? err.message : "System check failed");
			// Fallback pattern to allow user to proceed or retry
			if (!pattern) {
				setPattern("D_OFFLINE_NO_RUN"); 
			}
		} finally {
			setIsChecking(false);
		}
	}, [refreshOllama, refreshLmStudio, refetchRequirements, defaultModels, pattern]);

	// Auto-run system check if preference is present but pattern is not resolved
	useEffect(() => {
		if (internetPreference && !pattern && !isChecking && defaultModels && !checkError) {
			void runSystemCheck(internetPreference);
		}
	}, [internetPreference, pattern, isChecking, defaultModels, runSystemCheck, checkError]);

	return {
		pattern,
		isChecking,
		checkError,
		runSystemCheck,
		requirements,
		defaultModels,
	};
}
