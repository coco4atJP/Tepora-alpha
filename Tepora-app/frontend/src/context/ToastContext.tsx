import type React from "react";
import { createContext, useCallback, useContext, useState } from "react";
import { ToastContainer, type ToastType } from "../components/ui/Toast";

interface Toast {
	id: string;
	type: ToastType;
	message: string;
	duration?: number;
}

interface ToastContextType {
	showToast: (type: ToastType, message: string, duration?: number) => void;
	dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
	children,
}) => {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const showToast = useCallback(
		(type: ToastType, message: string, duration = 5000) => {
			const id = Math.random().toString(36).substring(2, 9);
			setToasts((prev) => [...prev, { id, type, message, duration }]);
		},
		[],
	);

	const dismissToast = useCallback((id: string) => {
		setToasts((prev) => prev.filter((toast) => toast.id !== id));
	}, []);

	return (
		<ToastContext.Provider value={{ showToast, dismissToast }}>
			{children}
			<ToastContainer toasts={toasts} onDismiss={dismissToast} />
		</ToastContext.Provider>
	);
};

// eslint-disable-next-line react-refresh/only-export-components
export const useToast = () => {
	const context = useContext(ToastContext);
	if (!context) {
		throw new Error("useToast must be used within a ToastProvider");
	}
	return context;
};
