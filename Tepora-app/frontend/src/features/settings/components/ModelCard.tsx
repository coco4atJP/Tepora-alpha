import {
    Cpu,
    Database,
    HardDrive,
    Play,
    Trash2,
    Check
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { FitText } from "../../../components/ui/FitText";
import type { ModelInfo } from "../../../types";

interface ModelCardProps {
    model: ModelInfo;
    isActive: boolean;
    isDownloading?: boolean;
    downloadProgress?: number;
    onActivate: (id: string) => void;
    onDelete: (id: string) => void;
    onDownload?: (id: string) => void; // Future use if we support re-download/update
}

export const ModelCard: React.FC<ModelCardProps> = ({
    model,
    isActive,
    isDownloading,
    downloadProgress,
    onActivate,
    onDelete,
}) => {
    const { t } = useTranslation();

    const formatSize = (bytes: number) => {
        if (bytes === 0) return "Unknown size";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    };

    const getRoleIcon = (role: string) => {
        switch (role) {
            case "text":
                return <MessageSquareIcon className="w-4 h-4" />;
            case "embedding":
                return <Database className="w-4 h-4" />;
            default:
                return <Cpu className="w-4 h-4" />;
        }
    };

    const getRoleLabel = (role: string) => {
        switch (role) {
            case "text":
                return t("model.role.text", "Text Generation");
            case "embedding":
                return t("model.role.embedding", "Embedding");
            default:
                return role;
        }
    };

    return (
        <div className={`
            relative group flex flex-col justify-between
            glass-panel p-5
            hover:shadow-[0_0_20px_rgba(252,211,77,0.15)]
            ${isActive ? "ring-1 ring-gold-400 bg-gold-900/10 glow-border" : ""}
        `}>
            {/* Active Indicator */}
            {isActive && (
                <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-gold-500/20 text-gold-300 text-[10px] uppercase tracking-wider font-bold border border-gold-500/30 flex items-center gap-1.5 shadow-sm">
                    <Check size={12} strokeWidth={3} />
                    {t("common.active", "Active")}
                </div>
            )}

            {/* Content Top */}
            <div className="space-y-4 mb-5">
                <div className="flex items-start justify-between min-h-[3rem]">
                    <div className="flex-1 pr-4">
                        <FitText className="font-semibold text-white/95 line-clamp-2 tracking-tight" minFontSize={14} maxFontSize={18}>
                            {model.display_name}
                        </FitText>
                        <div className="flex items-center gap-2 mt-1.5 text-[11px] font-medium text-tea-300/80 uppercase tracking-wide">
                            {getRoleIcon(model.role)}
                            <span>{getRoleLabel(model.role)}</span>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs text-tea-200/70">
                    <div className="flex items-center gap-2 bg-black/30 rounded-lg px-2.5 py-1.5 border border-white/5">
                        <HardDrive size={12} className="text-tea-400/60" />
                        <span className="font-medium">{formatSize(model.file_size)}</span>
                    </div>
                    <div className="flex items-center gap-2 bg-black/30 rounded-lg px-2.5 py-1.5 border border-white/5">
                        <Cpu size={12} className="text-tea-400/60" />
                        <span className="truncate font-medium" title={model.filename}>{model.filename || "Unknown"}</span>
                    </div>
                </div>
            </div>

            {/* Download Progress Overlay */}
            {isDownloading && (
                <div className="absolute inset-0 bg-bg-app/80 backdrop-blur-md flex flex-col items-center justify-center p-5 z-10 transition-opacity rounded-2xl">
                    <div className="w-full text-center space-y-3">
                        <div className="flex justify-between text-xs font-medium text-tea-200 mb-1 px-1">
                            <span>{t("common.downloading", "Downloading...")}</span>
                            <span className="text-gold-300">{Math.round(downloadProgress || 0)}%</span>
                        </div>
                        <div className="w-full bg-black/40 rounded-full h-2 overflow-hidden border border-white/5">
                            <div
                                className="h-full bg-gradient-to-r from-tea-400 to-gold-400 transition-all duration-300 ease-out shadow-[0_0_10px_rgba(252,211,77,0.5)]"
                                style={{ width: `${downloadProgress}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Actions Bottom */}
            <div className="flex items-center gap-2 pt-4 border-t border-white/5 opacity-80 group-hover:opacity-100 transition-all duration-300 mt-auto">
                {!isActive && (
                    <button
                        onClick={() => onActivate(model.id)}
                        className="flex-1 px-3 py-2 rounded-xl bg-white/5 hover:bg-gold-500/20 hover:border-gold-500/30 border border-transparent text-tea-100/90 text-[11px] font-bold tracking-wide uppercase transition-all flex items-center justify-center gap-1.5 hover:shadow-[0_0_12px_rgba(252,211,77,0.15)] hover:-translate-y-0.5"
                    >
                        <Play size={12} className="fill-current" />
                        {t("common.activate", "Activate")}
                    </button>
                )}

                <button
                    onClick={() => onDelete(model.id)}
                    className="p-2.5 rounded-xl bg-white/5 hover:bg-red-500/20 border border-transparent hover:border-red-500/30 text-tea-100/60 hover:text-red-400 transition-all flex items-center justify-center hover:shadow-[0_0_12px_rgba(239,68,68,0.15)] hover:-translate-y-0.5"
                    title={t("common.delete", "Delete")}
                >
                    <Trash2 size={16} />
                </button>
            </div>
        </div>
    );
};

// Helper Icon Component
function MessageSquareIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    )
}
