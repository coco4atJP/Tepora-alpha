import React, { useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionHistoryPanel } from './SessionHistoryPanel';

interface SessionHistoryModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const SessionHistoryModal: React.FC<SessionHistoryModalProps> = ({ isOpen, onClose }) => {
    const { t } = useTranslation();
    const modalRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = 'unset';
        };
    }, [isOpen, onClose]);

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
            onClick={handleBackdropClick}
        >
            <div
                ref={modalRef}
                className="relative w-full max-w-lg h-[80vh] bg-[#1e1e2e] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-scale-in"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-white/5">
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <span>{t('sessionHistory', 'Sessions')}</span>
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        aria-label={t('close', 'Close')}
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 bg-[#1e1e2e]/95">
                    {/* We pass a custom onSelect wrapper to close modal on selection if needed, 
                        or we can let the user manually close it. 
                        Currently SessionHistoryPanel handles selection deeply. 
                        Ideally, selecting a session should close the modal.
                        We can modify SessionHistoryPanel to accept an onSessionSelect callback or handled internally.
                        For now, let's keep it simple. If we need auto-close, we might need to modify SessionHistoryPanel props.
                    */}
                    <SessionHistoryPanel onSessionSelect={onClose} />
                </div>
            </div>
        </div>
    );
};
