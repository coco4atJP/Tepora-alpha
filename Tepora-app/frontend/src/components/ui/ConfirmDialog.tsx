/**
 * ConfirmDialog - カスタム確認ダイアログコンポーネント
 * UX改善3: window.confirm()の代わりにUIに統一された確認モーダルを使用
 */

import type React from "react";
import { useTranslation } from "react-i18next";

interface ConfirmDialogProps {
	isOpen: boolean;
	title?: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void;
	onCancel: () => void;
	variant?: "danger" | "default";
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
	isOpen,
	title,
	message,
	confirmLabel,
	cancelLabel,
	onConfirm,
	onCancel,
	variant = "default",
}) => {
	const { t } = useTranslation();

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 bg-theme-overlay backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
			<div
				className="bg-theme-panel border border-theme-border rounded-xl shadow-2xl max-w-sm w-full p-6 animate-in zoom-in-95 duration-200"
				onClick={(e) => e.stopPropagation()}
			>
				{title && (
					<h3 className="text-lg font-semibold text-theme-text mb-2">
						{title}
					</h3>
				)}
				<p className="text-theme-subtext text-sm mb-6 leading-relaxed">
					{message}
				</p>
				<div className="flex justify-end gap-3">
					<button
						className="px-4 py-2 rounded-lg text-sm font-medium text-theme-subtext hover:text-theme-text hover:bg-theme-glass-highlight transition-colors"
						onClick={onCancel}
					>
						{cancelLabel || t("common.cancel", "キャンセル")}
					</button>
					<button
						className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 ${
							variant === "danger"
								? "bg-red-600 hover:bg-red-700 text-white focus:ring-red-500"
								: "bg-gold-500 hover:bg-gold-600 text-black focus:ring-gold-500"
						}`}
						onClick={onConfirm}
					>
						{confirmLabel || t("common.confirm", "確認")}
					</button>
				</div>
			</div>
		</div>
	);
};

export default ConfirmDialog;
