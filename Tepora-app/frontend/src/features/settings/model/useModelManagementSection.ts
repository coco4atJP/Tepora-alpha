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
import { useModelManagementFilters } from "./useModelManagementFilters";
import { useModelManagementJobs } from "./useModelManagementJobs";

export function useModelManagementSection() {
	const queryClient = useQueryClient();
	const modelsQuery = useV2SetupModelsQuery();
	const deleteModel = useDeleteSetupModelMutation();
	const startDownload = useStartModelDownload();
	const { updateStatus, isChecking, checkAllModels } = useModelUpdateCheck();
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
	};
}
