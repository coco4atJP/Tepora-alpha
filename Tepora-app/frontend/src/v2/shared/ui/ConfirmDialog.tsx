import React from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
	isOpen: boolean;
	title?: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "default" | "danger" | "warning";
	onConfirm: () => void;
	onCancel: () => void;
	children?: React.ReactNode;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
	isOpen,
	title,
	message,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	variant = "default",
	onConfirm,
	onCancel,
	children,
}) => {
	const confirmVariant =
		variant === "danger" ? "primary" : variant === "warning" ? "secondary" : "primary";

	return (
		<Modal isOpen={isOpen} onClose={onCancel} title={title} size="md">
			<div className="space-y-4">
				<p className="text-sm leading-relaxed text-text-muted">{message}</p>
				{children}
				<div className="flex justify-end gap-3">
					<Button variant="ghost" onClick={onCancel}>
						{cancelLabel}
					</Button>
					<Button
						variant={confirmVariant}
						onClick={onConfirm}
						className={
							variant === "danger"
								? "border-transparent bg-red-600 text-white hover:bg-red-500"
								: variant === "warning"
									? "border-amber-500/40 text-amber-200 hover:bg-amber-500/10"
									: ""
						}
					>
						{confirmLabel}
					</Button>
				</div>
			</div>
		</Modal>
	);
};
