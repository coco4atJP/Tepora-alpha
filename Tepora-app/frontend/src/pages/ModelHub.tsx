import { Grid, RefreshCw, Search, Server, X } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";

import { useSettings } from "../hooks/useSettings";
import { modelsApi } from "../api/models";
import { ModelCard } from "../features/settings/components/ModelCard";
import { loadersApi } from "../api/loaders";
import type { ModelInfo } from "../types";
import { logger } from "../utils/logger";
import { ModelDetailOverlay } from "../features/settings/components/subcomponents/ModelDetailOverlay";

interface ModelHubProps {
    isOpen: boolean;
    onClose: () => void;
}

const ModelHub: React.FC<ModelHubProps> = ({ isOpen, onClose }) => {
    const { t } = useTranslation();
    const { updateModel, config } = useSettings();
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [filterRole, setFilterRole] = useState<"all" | "text" | "embedding">("all");
    const [isRefreshing, setIsRefreshing] = useState(false);

    // States for Model Settings Modal
    const [editingModel, setEditingModel] = useState<ModelInfo | null>(null);
    const [isDetailOpen, setIsDetailOpen] = useState(false);

    // Handle Escape key to close
    useEffect(() => {
        if (!isOpen) return;
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
    }, [isOpen, onClose]);

    const fetchModels = useCallback(async () => {
        setIsLoading(true);
        try {
            const data = await modelsApi.list();
            setModels(data.models || []);
        } catch (e) {
            logger.error("Failed to fetch models", e);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchModels();
    }, [fetchModels]);

    const handleSettings = (model: ModelInfo) => {
        setEditingModel(model);
        setIsDetailOpen(true);
    };

    const handleDelete = async (id: string) => {
        if (!confirm(t("settings.sections.models.confirm_delete", "Are you sure you want to delete this model?"))) return;

        try {
            await modelsApi.delete(id);
            fetchModels();
        } catch (e) {
            logger.error("Failed to delete model", e);
        }
    };

    const handleRefreshLoaders = async () => {
        setIsRefreshing(true);
        try {
            await Promise.all([
                loadersApi.refreshOllamaModels(),
                loadersApi.refreshLmStudioModels()
            ]);
            await fetchModels();
        } catch (e) {
            logger.error("Failed to refresh loaders", e);
        } finally {
            setIsRefreshing(false);
        }
    };

    const filteredModels = models.filter(m => {
        const matchesSearch = m.display_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            m.filename?.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesRole = filterRole === "all" || m.role === filterRole;
        return matchesSearch && matchesRole;
    });

    if (!isOpen) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 md:p-8 md:pt-12 bg-black/60 backdrop-blur-md animate-in fade-in duration-200"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="flex flex-col w-full max-w-6xl h-full max-h-[85vh] bg-[#0A0A0C] text-gray-200 rounded-3xl overflow-hidden shadow-2xl border border-white/10 animate-in zoom-in-95 duration-200">

                {/* Header */}
                <div className="flex-none px-6 md:px-8 py-5 border-b border-white/5 bg-white/[0.02] flex items-center justify-between z-10">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-tea-500/10 border border-tea-500/20 flex items-center justify-center">
                            <Grid size={20} className="text-tea-400" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-white tracking-wide">
                                {t("modelHub.title", "Visual Model Hub")}
                            </h1>
                            <p className="text-xs text-white/50 font-medium tracking-wide mt-0.5">
                                {t("modelHub.subtitle", "Manage your local AI models library")}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleRefreshLoaders}
                            disabled={isRefreshing}
                            className="px-4 py-2 flex items-center gap-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 text-sm font-semibold text-white/80 transition-all hover:border-white/20"
                        >
                            <Server size={16} className={isRefreshing ? "animate-spin text-tea-400" : "text-white/40"} />
                            <span className="hidden sm:inline">
                                {isRefreshing ? t("common.refreshing", "Refreshing...") : t("common.scan_providers", "Scan Providers")}
                            </span>
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 text-white/40 hover:text-white hover:bg-white/10 rounded-xl transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Controls Bar */}
                <div className="flex-none px-6 md:px-8 py-4 border-b border-white/5 bg-black/40 flex flex-col sm:flex-row items-start sm:items-center gap-4 z-10 w-full">
                    {/* Search */}
                    <div className="relative w-full sm:max-w-md">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30" size={16} />
                        <input
                            type="text"
                            placeholder={t("modelHub.search_placeholder", "Search models...")}
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pl-10 pr-4 py-2.5 bg-black/40 border border-white/10 rounded-xl text-sm text-white focus:outline-none focus:border-tea-500/50 focus:bg-white/[0.03] placeholder-white/20 transition-all font-medium"
                        />
                    </div>

                    {/* Filter Tabs */}
                    <div className="flex items-center gap-1.5 p-1 bg-black/40 border border-white/5 rounded-xl w-full sm:w-auto overflow-x-auto no-scrollbar">
                        {(["all", "text", "embedding"] as const).map((role) => (
                            <button
                                key={role}
                                onClick={() => setFilterRole(role)}
                                className={`
                                px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all whitespace-nowrap
                                ${filterRole === role
                                        ? "bg-tea-500/20 text-tea-200"
                                        : "text-white/40 hover:text-white/80 hover:bg-white/5"}
                            `}
                            >
                                {role === "all" ? t("common.all", "All") :
                                    role === "text" ? t("model.role.text", "Text") :
                                        t("model.role.embedding", "Embedding")}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Grid Content */}
                <div className="flex-1 overflow-y-auto p-6 md:p-8 bg-[#0A0A0C] custom-scrollbar z-10 relative">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center h-full text-white/40 gap-4">
                            <RefreshCw className="animate-spin text-tea-400" size={28} />
                            <span className="text-sm font-semibold tracking-widest uppercase">{t("common.loading", "Loading models...")}</span>
                        </div>
                    ) : filteredModels.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-white/50 gap-4">
                            <div className="w-16 h-16 rounded-2xl bg-white/[0.02] border border-white/5 flex items-center justify-center mb-2">
                                <Grid size={28} className="text-white/20" />
                            </div>
                            <p className="text-sm font-medium">{t("modelHub.no_models_found", "No models found matching your criteria.")}</p>
                            <button className="text-tea-400 text-xs font-bold uppercase tracking-widest mt-2 hover:text-tea-300 transition-colors" onClick={() => { setSearchTerm(""); setFilterRole("all"); }}>
                                {t("common.clear_filters", "Clear Filters")}
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5 auto-rows-max">
                            {filteredModels.map(model => (
                                <ModelCard
                                    key={model.id}
                                    model={model}
                                    isActive={model.is_active || false}
                                    onSettings={handleSettings}
                                    onDelete={handleDelete}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Model Settings Detail Overlay */}
            {editingModel && config && (
                <ModelDetailOverlay
                    isOpen={isDetailOpen}
                    onClose={() => {
                        setIsDetailOpen(false);
                        setTimeout(() => setEditingModel(null), 300); // delay clear to allow out-animation
                    }}
                    title={`${editingModel.display_name} Configuration`}
                    config={config.models_gguf[editingModel.id] || {
                        path: editingModel.file_path || "",
                        port: editingModel.role === "embedding" ? 8081 : 8080,
                        n_ctx: editingModel.role === "embedding" ? 2048 : 4096,
                        n_gpu_layers: -1,
                        temperature: 0.7,
                        top_p: 0.9,
                    }}
                    onChange={(newConfig) => {
                        updateModel(editingModel.id, newConfig);
                    }}
                    isEmbedding={editingModel.role === "embedding"}
                />
            )}
        </div>,
        document.body
    );
};

export default ModelHub;
