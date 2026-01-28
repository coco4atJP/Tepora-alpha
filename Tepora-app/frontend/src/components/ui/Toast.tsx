import { AlertCircle, CheckCircle, Info, X, XCircle } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastProps {
	id: string;
	type: ToastType;
	message: string;
	duration?: number;
	onDismiss: (id: string) => void;
}

const icons = {
	success: CheckCircle,
	error: XCircle,
	info: Info,
	warning: AlertCircle,
};

const styles = {
	success: "bg-green-500/10 text-green-400 border-green-500/20",
	error: "bg-red-500/10 text-red-400 border-red-500/20",
	info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
	warning: "bg-gold-500/10 text-gold-400 border-gold-500/20",
};

export const Toast: React.FC<ToastProps> = ({
	id,
	type,
	message,
	duration = 5000,
	onDismiss,
}) => {
	const Icon = icons[type];
	const [isVisible, setIsVisible] = useState(false);

	useEffect(() => {
		// Trigger enter animation
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	useEffect(() => {
		if (duration > 0) {
			const timer = setTimeout(() => {
				setIsVisible(false);
				// Wait for exit animation to finish before actual dismiss
				setTimeout(() => onDismiss(id), 300);
			}, duration);
			return () => clearTimeout(timer);
		}
	}, [duration, id, onDismiss]);

	const handleDismiss = () => {
		setIsVisible(false);
		setTimeout(() => onDismiss(id), 300);
	};

	return (
		<div
			className={`flex items-center gap-3 px-4 py-3 rounded-lg border backdrop-blur-md shadow-lg min-w-[300px] max-w-md pointer-events-auto transition-all duration-300 transform ${
				styles[type]
			} ${isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-4 scale-95"}`}
			role="alert"
		>
			<Icon className="w-5 h-5 shrink-0" />
			<p className="text-sm font-medium flex-1">{message}</p>
			<button
				type="button"
				onClick={handleDismiss}
				className="p-1 hover:bg-white/10 rounded-full transition-colors"
				aria-label="Close notification"
			>
				<X className="w-4 h-4 opacity-70 hover:opacity-100" />
			</button>
		</div>
	);
};

export const ToastContainer: React.FC<{
	toasts: Omit<ToastProps, "onDismiss">[];
	onDismiss: (id: string) => void;
}> = ({ toasts, onDismiss }) => {
	return (
		<div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
			{toasts.map((toast) => (
				<Toast key={toast.id} {...toast} onDismiss={onDismiss} />
			))}
		</div>
	);
};
