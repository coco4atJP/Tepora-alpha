import React from "react";
import type { SetupModel } from "../../../../shared/contracts";
import { ConfirmDialog } from "../../../../shared/ui";

interface ConsentRequest {
	warnings: string[];
}

interface ModelManagementDialogsProps {
	consentRequest: ConsentRequest | null;
	onCancelConsent: () => void;
	onConfirmConsent: () => void;
	deleteTarget: SetupModel | null;
	onCancelDelete: () => void;
	onConfirmDelete: () => void;
}

export const ModelManagementDialogs: React.FC<ModelManagementDialogsProps> = ({
	consentRequest,
	onCancelConsent,
	onConfirmConsent,
	deleteTarget,
	onCancelDelete,
	onConfirmDelete,
}) => {
	return (
		<>
			<ConfirmDialog
				isOpen={Boolean(consentRequest)}
				title="Confirm Download"
				message="This download requires explicit confirmation before it can start."
				variant="warning"
				confirmLabel="Proceed"
				cancelLabel="Cancel"
				onCancel={onCancelConsent}
				onConfirm={onConfirmConsent}
			>
				<ul className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200 mt-2">
					{(consentRequest?.warnings.length
						? consentRequest.warnings
						: ["This download requires confirmation."]).map((warning) => (
						<li key={warning} className="flex items-start gap-2">
							<span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"></span>
							<span>{warning}</span>
						</li>
					))}
				</ul>
			</ConfirmDialog>

			<ConfirmDialog
				isOpen={Boolean(deleteTarget)}
				title="Delete Model"
				message={
					deleteTarget
						? `Delete ${deleteTarget.display_name}? This removes the model entry and any managed local file.`
						: ""
				}
				variant="danger"
				confirmLabel="Delete"
				cancelLabel="Cancel"
				onCancel={onCancelDelete}
				onConfirm={onConfirmDelete}
			/>
		</>
	);
};
