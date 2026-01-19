import { X } from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	title?: string;
	children: React.ReactNode;
	className?: string;
	size?: "md" | "lg" | "xl";
	customContent?: boolean;
}

const Modal: React.FC<ModalProps> = ({
	isOpen,
	onClose,
	title,
	children,
	className = "",
	size = "md",
	customContent = false,
}) => {
	const overlayRef = useRef<HTMLDivElement>(null);

	// Close on Escape key
	useEffect(() => {
		if (!isOpen) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};

		const previousOverflow = document.body.style.overflow;
		document.addEventListener("keydown", handleEscape);
		document.body.style.overflow = "hidden"; // Prevent scrolling behind modal

		return () => {
			document.removeEventListener("keydown", handleEscape);
			document.body.style.overflow = previousOverflow;
		};
	}, [isOpen, onClose]);

	// Close on click outside
	const handleBackdropClick = (e: React.MouseEvent) => {
		if (e.target === overlayRef.current) {
			onClose();
		}
	};

	if (!isOpen) return null;

	const sizeClasses = {
		md: "max-w-lg",
		lg: "max-w-2xl",
		xl: "max-w-4xl",
	};

	const modalContent = (
		<div
			className="fixed inset-0 z-[100] flex items-center justify-center p-4 min-h-screen overflow-y-auto"
			role="dialog"
			aria-modal="true"
		>
			{/* Backdrop */}
			<div
				ref={overlayRef}
				className="fixed inset-0 bg-theme-overlay backdrop-blur-sm transition-opacity"
				onClick={handleBackdropClick}
			/>

			{/* Modal Container */}
			<div
				className={`
                    relative w-full ${sizeClasses[size] || sizeClasses.md} transform rounded-xl 
                    bg-theme-panel border border-theme-border shadow-2xl 
                    transition-all animate-in fade-in zoom-in-95 duration-200
                    ${className}
                `}
			>
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b border-theme-border">
					<h3 className="text-lg font-semibold text-theme-text">{title}</h3>
					<button
						onClick={onClose}
						className="p-1 rounded-md text-theme-subtext hover:text-theme-text hover:bg-theme-glass-highlight transition-colors"
						aria-label="Close"
					>
						<X size={20} />
					</button>
				</div>

				{/* Content */}
				{customContent ? (
					children
				) : (
					<div className="p-4 overflow-y-auto max-h-[80vh] text-theme-text">
						{children}
					</div>
				)}
			</div>
		</div>
	);

	// Use Portal if document is available, otherwise normal render (SSR safety)
	if (typeof document !== "undefined") {
		return createPortal(modalContent, document.body);
	}
	return modalContent;
};

export default Modal;
