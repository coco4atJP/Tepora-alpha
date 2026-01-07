import { useCallback, useState } from "react";
import { getApiBase } from "../utils/api";

export interface UpdateCheckResult {
	update_available: boolean;
	reason:
		| "revision_mismatch"
		| "sha256_mismatch"
		| "up_to_date"
		| "insufficient_data"
		| "unknown";
	current_revision?: string;
	latest_revision?: string;
	current_sha256?: string;
	latest_sha256?: string;
}

interface UseModelUpdateCheck {
	checkUpdate: (modelId: string) => Promise<UpdateCheckResult | null>;
	updateStatus: Record<string, UpdateCheckResult>;
	isChecking: boolean;
	checkAllModels: (modelIds: string[]) => Promise<void>;
}

export const useModelUpdateCheck = (): UseModelUpdateCheck => {
	const [updateStatus, setUpdateStatus] = useState<
		Record<string, UpdateCheckResult>
	>({});
	const [isChecking, setIsChecking] = useState(false);

	const checkUpdate = useCallback(
		async (modelId: string): Promise<UpdateCheckResult | null> => {
			try {
				const res = await fetch(
					`${getApiBase()}/api/setup/model/update-check?model_id=${encodeURIComponent(modelId)}`,
				);
				if (!res.ok) {
					console.error(
						`Failed to check update for model ${modelId}:`,
						res.statusText,
					);
					return null;
				}
				const result: UpdateCheckResult = await res.json();
				setUpdateStatus((prev) => ({ ...prev, [modelId]: result }));
				return result;
			} catch (error) {
				console.error(`Error checking update for model ${modelId}:`, error);
				return null;
			}
		},
		[],
	);

	const checkAllModels = useCallback(
		async (modelIds: string[]) => {
			setIsChecking(true);
			try {
				// Run checks in parallel but limit concurrency if needed (currently all at once)
				await Promise.all(modelIds.map((id) => checkUpdate(id)));
			} finally {
				setIsChecking(false);
			}
		},
		[checkUpdate],
	);

	return {
		checkUpdate,
		updateStatus,
		isChecking,
		checkAllModels,
	};
};
