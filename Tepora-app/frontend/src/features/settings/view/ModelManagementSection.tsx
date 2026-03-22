import { Search } from "lucide-react";
import React from "react";
import { normalizeModelRole } from "../../../shared/lib/modelManagement";
import { AsyncJobStatus, Button } from "../../../shared/ui";
import { useModelManagementSection } from "../model/useModelManagementSection";
import { ModelManagementControls } from "./components/ModelManagementControls";
import { ModelManagementDialogs } from "./components/ModelManagementDialogs";
import { SetupModelCard } from "./components/SetupModelCard";

export const ModelManagementSection: React.FC = () => {
	const {
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
	} = useModelManagementSection();

	return (
		<div className="flex flex-col gap-6 w-full mx-auto">
			<ModelManagementControls
				searchTerm={searchTerm}
				onSearchTermChange={setSearchTerm}
				activeRole={activeRole}
				onActiveRoleChange={setActiveRole}
				onCheckUpdates={() => void checkAllModels(remoteModels)}
				isChecking={isChecking}
				remoteModelCount={remoteModels.length}
				isBusy={isBusy}
			/>

			{progressSnapshot ? (
				<AsyncJobStatus
					status={progressSnapshot.status}
					progress={progressSnapshot.progress}
					message={progressSnapshot.message}
				/>
			) : null}

			{errorMessage ? (
				<div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
					{errorMessage}
				</div>
			) : null}

			{/* Installed Models Grid */}
			<div className="space-y-4">
				<div className="flex items-center justify-between pb-3 border-b border-border/40 mt-2">
					<h3 className="font-serif text-[18px] font-semibold tracking-wide text-text-main">
						Installed Models
					</h3>
					<p className="text-[11px] font-bold uppercase tracking-widest text-text-muted">
						{filteredModels.length} {filteredModels.length === 1 ? "model" : "models"} found
					</p>
				</div>

				{modelsQuery.isLoading ? (
					<div className="text-sm text-text-muted mt-4">Loading models...</div>
				) : filteredModels.length === 0 ? (
					<div className="flex flex-col items-center justify-center p-12 text-text-muted gap-4 border border-dashed border-border/60 rounded-2xl bg-surface/30 mt-4">
						<div className="w-16 h-16 rounded-2xl bg-primary/5 border border-primary/10 flex items-center justify-center mb-2">
							<Search size={28} className="text-primary/40" />
						</div>
						<p className="text-sm font-medium">No models found matching your criteria.</p>
						{(searchTerm || activeRole !== "all") && (
							<Button
								type="button"
								variant="ghost"
								onClick={clearFilters}
								className="mt-2 text-[11px] font-bold uppercase tracking-widest text-primary border border-border/50"
							>
								Clear Filters
							</Button>
						)}
					</div>
				) : (
					<div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 mt-4">
						{filteredModels.map((model) => (
							<SetupModelCard
								key={model.id}
								model={model}
								status={updateStatus[model.id]}
								isBusy={isBusy}
								isChecking={isChecking}
								isDeleting={deleteModel.isPending}
								isUpdating={startDownload.isPending}
								onCheck={() => void checkAllModels([model])}
								onUpdate={() =>
									void startDownloadFlow({
										repo_id: model.repo_id ?? model.source,
										filename: model.filename ?? "",
										role: normalizeModelRole(model.role),
										display_name: model.display_name,
										revision: model.revision ?? undefined,
										sha256: model.sha256 ?? undefined,
										acknowledge_warnings: false,
									})
								}
								onDelete={() => setDeleteTarget(model)}
							/>
						))}
					</div>
				)}
			</div>

			<ModelManagementDialogs
				consentRequest={consentRequest}
				onCancelConsent={() => setConsentRequest(null)}
				onConfirmConsent={confirmConsentDownload}
				deleteTarget={deleteTarget}
				onCancelDelete={() => setDeleteTarget(null)}
				onConfirmDelete={() => void handleDelete()}
			/>
		</div>
	);
};
