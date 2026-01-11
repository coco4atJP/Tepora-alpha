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
		<div className="confirm-dialog-overlay" onClick={onCancel}>
			<div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
				{title && <h3 className="confirm-dialog-title">{title}</h3>}
				<p className="confirm-dialog-message">{message}</p>
				<div className="confirm-dialog-actions">
					<button className="btn-cancel" onClick={onCancel}>
						{cancelLabel || t("common.cancel", "キャンセル")}
					</button>
					<button
						className={`btn-confirm ${variant === "danger" ? "btn-danger" : ""}`}
						onClick={onConfirm}
					>
						{confirmLabel || t("common.confirm", "確認")}
					</button>
				</div>

				<style>{`
                    .confirm-dialog-overlay {
                        position: fixed;
                        inset: 0;
                        background: rgba(0, 0, 0, 0.6);
                        backdrop-filter: blur(4px);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        z-index: 1000;
                        animation: fadeIn 0.15s ease-out;
                    }

                    @keyframes fadeIn {
                        from { opacity: 0; }
                        to { opacity: 1; }
                    }

                    .confirm-dialog {
                        background: var(--color-bg-secondary, rgba(30, 30, 40, 0.95));
                        border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
                        border-radius: 12px;
                        padding: 20px 24px;
                        min-width: 300px;
                        max-width: 400px;
                        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                        animation: slideUp 0.2s ease-out;
                    }

                    @keyframes slideUp {
                        from { 
                            opacity: 0;
                            transform: translateY(10px);
                        }
                        to {
                            opacity: 1;
                            transform: translateY(0);
                        }
                    }

                    .confirm-dialog-title {
                        margin: 0 0 8px 0;
                        font-size: 16px;
                        font-weight: 600;
                        color: var(--color-text-primary, #fff);
                    }

                    .confirm-dialog-message {
                        margin: 0 0 20px 0;
                        font-size: 14px;
                        color: var(--color-text-secondary, rgba(255, 255, 255, 0.8));
                        line-height: 1.5;
                    }

                    .confirm-dialog-actions {
                        display: flex;
                        gap: 12px;
                        justify-content: flex-end;
                    }

                    .confirm-dialog-actions button {
                        padding: 8px 16px;
                        border-radius: 8px;
                        border: none;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.2s;
                    }

                    .confirm-dialog-actions .btn-cancel {
                        background: transparent;
                        color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
                        border: 1px solid var(--color-border, rgba(255, 255, 255, 0.2));
                    }

                    .confirm-dialog-actions .btn-cancel:hover {
                        background: rgba(255, 255, 255, 0.1);
                        color: var(--color-text-primary, #fff);
                    }

                    .confirm-dialog-actions .btn-confirm {
                        background: var(--color-primary, #6366f1);
                        color: white;
                    }

                    .confirm-dialog-actions .btn-confirm:hover {
                        background: var(--color-primary-hover, #818cf8);
                        transform: translateY(-1px);
                    }

                    .confirm-dialog-actions .btn-confirm.btn-danger {
                        background: #dc2626;
                    }

                    .confirm-dialog-actions .btn-confirm.btn-danger:hover {
                        background: #ef4444;
                    }
                `}</style>
			</div>
		</div>
	);
};

export default ConfirmDialog;
