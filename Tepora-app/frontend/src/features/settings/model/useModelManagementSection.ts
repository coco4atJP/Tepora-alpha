import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	useModelUpdateCheck,
	useStartModelDownload,
} from "../../../shared/lib/modelManagement";
import {
	useDeleteSetupModelMutation,
	useV2SetupModelsQuery,
} from "./queries";
import {
	useRefreshLmStudioMutation,
	useRefreshOllamaMutation,
} from "../../setup/model/setupQueries";
import { useModelManagementFilters } from "./useModelManagementFilters";
import { useModelManagementJobs } from "./useModelManagementJobs";

export function useModelManagementSection() {
	const queryClient = useQueryClient();
	const modelsQuery = useV2SetupModelsQuery();
	const deleteModel = useDeleteSetupModelMutation();
	const startDownload = useStartModelDownload();
	const { updateStatus, isChecking, checkAllModels } = useModelUpdateCheck();
	const refreshOllama = useRefreshOllamaMutation();
	const refreshLmStudio = useRefreshLmStudioMutation();

	const handleRefreshLocalModels = async () => {
		try {
			await Promise.allSettled([
				refreshOllama.mutateAsync(),
				refreshLmStudio.mutateAsync()
			]);
			await modelsQuery.refetch();
		} catch (error) {
			console.error("Failed to refresh models:", error);
		}
	};
	
	const isRefreshing = refreshOllama.isPending || refreshLmStudio.isPending;

	const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data?.models]);
	const {
		activeRole,
		setActiveRole,
		searchTerm,
		setSearchTerm,
		filteredModels,
		remoteModels,
		clearFilters,
	} = useModelManagementFilters(models);
	const {
		progressSnapshot,
		isBusy,
		errorMessage,
		consentRequest,
		setConsentRequest,
		deleteTarget,
		setDeleteTarget,
		startDownloadFlow,
		confirmConsentDownload,
		handleDelete,
	} = useModelManagementJobs({
		queryClient,
		startDownload,
		deleteModel,
	});

	return {
		modelsQuery,
		deleteModel,
		startDownload,
		updateStatus,
		isChecking,
		checkAllModels,
		activeRole,
		setActiveRole,
		searchTerm,
		setSearchTerm,
		filteredModels,
		remoteModels,
		progressSnapshot,
		isBusy,
		errorMessage,
		consentRequest,
		setConsentRequest,
		deleteTarget,
		setDeleteTarget,
		startDownloadFlow,
		confirmConsentDownload,
		handleDelete,
		clearFilters,
		handleRefreshLocalModels,
		isRefreshing,
	};
}
