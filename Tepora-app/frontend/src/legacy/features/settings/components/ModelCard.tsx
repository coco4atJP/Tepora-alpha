import {
    Cpu,
    Database,
    HardDrive,
    Settings2,
    Trash2
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { FitText } from "../../../components/ui/FitText";
import type { ModelInfo } from "../../../../types";

interface ModelCardProps {
    model: ModelInfo;
    isActive?: boolean;
    isDownloading?: boolean;
    downloadProgress?: number;
    onDelete: (id: string) => void;
    onSettings?: (model: ModelInfo) => void;
    onDownload?: (id: string) => void;
}

export const ModelCard: React.FC<ModelCardProps> = ({
    model,
    isDownloading,
    downloadProgress,
    onDelete,
    onSettings,
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

    // Generate derived tags based on filename, role, loader
    const tags = React.useMemo(() => {
        const t = [];
        if (model.role) t.push(model.role);
        if (model.loader) t.push(model.loader);

        const filenameLower = (model.filename || "").toLowerCase();
        if (filenameLower.includes("gguf")) t.push("gguf");
        if (filenameLower.includes("llama3") || filenameLower.includes("llama-3")) t.push("llama-3");
        if (filenameLower.includes("q4_k_m") || filenameLower.includes("q4")) t.push("q4");
        if (filenameLower.includes("q8_0") || filenameLower.includes("q8")) t.push("q8");
        if (filenameLower.includes("fp16")) t.push("fp16");

        // Remove duplicates and limit to 4 tags
        return Array.from(new Set(t)).slice(0, 4);
    }, [model]);

    return (
        <div className={`
            relative group flex flex-col justify-between
            bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-2xl p-5
            hover:border-tea-400/30 hover:bg-black/60
            transition-all duration-300 ease-out
            overflow-hidden
        `}>
            {/* Ambient Background Glow inside the card (Reduced) */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-tea-400/5 rounded-full blur-2xl -mr-10 -mt-10 group-hover:bg-tea-400/10 transition-colors pointer-events-none" />

            {/* Content Top */}
            <div className="space-y-4 mb-5 relative z-10">
                <div className="flex items-start justify-between min-h-[3rem]">
                    <div className="flex-1 min-w-0 pr-4">
                        <FitText className="font-semibold text-white/95 line-clamp-2 tracking-tight drop-shadow-sm" minFontSize={15} maxFontSize={19}>
                            {model.display_name}
                        </FitText>
                        <div className="flex items-center gap-2 mt-2 text-[11px] font-medium text-tea-200/90 uppercase tracking-widest">
                            {getRoleIcon(model.role)}
                            <span>{getRoleLabel(model.role)}</span>
                        </div>
                    </div>
                </div>

                {/* Tags visualization */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                    {tags.map((tag, idx) => (
                        <span key={idx} className="flex items-center px-1.5 py-0.5 rounded bg-white/[0.03] border border-white/[0.05] text-[10px] text-tea-200/60 font-medium tracking-wide">
                            {tag}
                        </span>
                    ))}
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs text-tea-100/80 pt-2">
                    <div className="flex items-center gap-2 px-1 py-1 min-w-0">
                        <HardDrive size={14} className="text-white/30 shrink-0" />
                        <span className="font-medium tracking-wide text-white/70">{formatSize(model.file_size)}</span>
                    </div>
                    <div className="flex items-center gap-2 px-1 py-1 min-w-0">
                        <Cpu size={14} className="text-white/30 shrink-0" />
                        <span className="truncate font-medium min-w-0 flex-1 tracking-wide text-white/70" title={model.filename}>{model.filename || "Unknown"}</span>
                    </div>
                </div>
            </div>

            {/* Download Progress Overlay */}
            {isDownloading && (
                <div className="absolute inset-0 bg-black/60 backdrop-blur-md flex flex-col items-center justify-center p-5 z-20 transition-opacity">
                    <div className="w-full text-center space-y-3">
                        <div className="flex justify-between text-xs font-medium text-tea-100 mb-1 px-1">
                            <span>{t("common.downloading", "Downloading...")}</span>
                            <span className="text-gold-300">{Math.round(downloadProgress || 0)}%</span>
                        </div>
                        <div className="w-full bg-black/50 rounded-full h-1.5 overflow-hidden border border-white/10">
                            <div
                                className="h-full bg-gradient-to-r from-tea-400 to-gold-400 transition-all duration-300 ease-out shadow-[0_0_10px_rgba(252,211,77,0.5)]"
                                style={{ width: `${downloadProgress}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Actions Bottom */}
            <div className="flex items-center gap-2 pt-4 border-t border-white/5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 mt-auto min-h-[52px] relative z-10">
                {onSettings && (
                    <button
                        onClick={() => onSettings(model)}
                        className="flex-1 px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 text-tea-100/80 text-[11px] font-semibold tracking-widest uppercase transition-all flex items-center justify-center gap-2"
                        title={t("common.settings", "Settings")}
                    >
                        <Settings2 size={14} />
                        {t("common.settings", "Settings")}
                    </button>
                )}

                <button
                    onClick={() => onDelete(model.id)}
                    className="p-2.5 rounded-lg bg-white/[0.03] hover:bg-red-500/10 border border-white/5 hover:border-red-500/20 text-white/40 hover:text-red-400 transition-all flex items-center justify-center shrink-0"
                    title={t("common.delete", "Delete")}
                >
                    <Trash2 size={14} />
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

