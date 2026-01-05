import { X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	children: React.ReactNode;
	title?: string;
	size?: "sm" | "md" | "lg" | "xl" | "full";
}

/**
 * Accessible Modal component with:
 * - Focus trapping
 * - Escape key to close
 * - Click outside to close
 * - ARIA attributes for screen readers
 */
const Modal: React.FC<ModalProps> = ({
	isOpen,
	onClose,
	children,
	title,
	size = "lg",
}) => {
	const modalRef = useRef<HTMLDivElement>(null);
	const previousActiveElement = useRef<HTMLElement | null>(null);

	// Prevent body scroll when modal is open
	useEffect(() => {
		if (isOpen) {
			previousActiveElement.current = document.activeElement as HTMLElement;
			document.body.style.overflow = "hidden";
			// Focus the modal container
			setTimeout(() => {
				modalRef.current?.focus();
			}, 10);
		} else {
			document.body.style.overflow = "";
			// Restore focus
			previousActiveElement.current?.focus();
		}
		return () => {
			document.body.style.overflow = "";
		};
	}, [isOpen]);

	// Handle Escape key
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
			// Focus trap
			if (e.key === "Tab" && modalRef.current) {
				const focusableElements =
					modalRef.current.querySelectorAll<HTMLElement>(
						'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
					);
				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];

				if (e.shiftKey) {
					if (document.activeElement === firstElement) {
						e.preventDefault();
						lastElement?.focus();
					}
				} else {
					if (document.activeElement === lastElement) {
						e.preventDefault();
						firstElement?.focus();
					}
				}
			}
		},
		[onClose],
	);

	// Handle backdrop click
	const handleBackdropClick = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) {
				onClose();
			}
		},
		[onClose],
	);

	if (!isOpen) return null;

	const sizeClasses: Record<string, string> = {
		sm: "max-w-md",
		md: "max-w-xl",
		lg: "max-w-3xl",
		xl: "max-w-5xl",
		full: "max-w-[95vw] w-full",
	};

	const modalContent = (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center p-4"
			role="presentation"
			onClick={handleBackdropClick}
			onKeyDown={handleKeyDown}
		>
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-black/70 backdrop-blur-md animate-fade-in"
				aria-hidden="true"
			/>

			{/* Modal Panel */}
			<div
				ref={modalRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={title ? "modal-title" : undefined}
				tabIndex={-1}
				className={`
                    relative z-10 w-full ${sizeClasses[size]} 
                    h-[85dvh] max-h-[900px]
                    flex flex-col
                    bg-gradient-to-br from-gray-900 via-coffee-950 to-gray-900
                    border border-gold-500/30
                    rounded-2xl shadow-2xl
                    overflow-hidden
                    animate-modal-enter
                `}
			>
				{/* Header */}
				<header className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
					{title && (
						<h2
							id="modal-title"
							className="text-lg font-semibold text-gray-100 tracking-wide"
						>
							{title}
						</h2>
					)}
					<button
						type="button"
						onClick={onClose}
						className="
                            ml-auto p-2 rounded-full
                            text-gray-400 hover:text-white hover:bg-white/10
                            transition-all duration-200
                            focus:outline-none focus:ring-2 focus:ring-gold-500/50
                        "
						aria-label="Close modal"
					>
						<X size={20} />
					</button>
				</header>

				{/* Content */}
				<div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
					{children}
				</div>
			</div>
		</div>
	);

	return createPortal(modalContent, document.body);
};

export default Modal;
