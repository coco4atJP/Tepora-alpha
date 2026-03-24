import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { Panel } from "./Panel";

export interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	title?: string;
	size?: "md" | "lg" | "xl";
	children: React.ReactNode;
}

const sizeClasses = {
	md: "max-w-xl",
	lg: "max-w-3xl",
	xl: "max-w-5xl",
};

export const Modal: React.FC<ModalProps> = ({
	isOpen,
	onClose,
	title,
	size = "md",
	children,
}) => {
	useEffect(() => {
		if (!isOpen) {
			return;
		}

		const previousOverflow = document.body.style.overflow;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};

		document.body.style.overflow = "hidden";
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.body.style.overflow = previousOverflow;
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [isOpen, onClose]);

	if (!isOpen || typeof document === "undefined") {
		return null;
	}

	return createPortal(
		<div className="fixed inset-0 z-[120] flex items-center justify-center bg-bg/65 px-4 py-8 backdrop-blur-md">
			<button
				type="button"
				aria-label="Close modal"
				className="absolute inset-0 cursor-default"
				onClick={onClose}
			/>
			<Panel
				variant="glass"
				className={`relative z-[121] w-full ${sizeClasses[size]} max-h-[85vh] overflow-hidden`}
			>
				<div className="flex items-center justify-between border-b border-border/40 px-6 py-4">
					<div>
						{title ? (
							<h2 className="font-serif text-xl text-text-main">{title}</h2>
						) : null}
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-full border border-border/60 px-3 py-1 text-sm text-text-muted transition-colors hover:border-primary/40 hover:text-text-main"
					>
						Close
					</button>
				</div>
				<div className="max-h-[calc(85vh-73px)] overflow-y-auto px-6 py-5">
					{children}
				</div>
			</Panel>
		</div>,
		document.body,
	);
};
