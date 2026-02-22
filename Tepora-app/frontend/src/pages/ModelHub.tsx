import { Grid, RefreshCw, Search, Server, X } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";

import { useSettings } from "../hooks/useSettings";
// import { useWebSocketStore } from "../stores"; // Unused for now
import { apiClient } from "../utils/api-client";
import { ModelCard } from "../features/settings/components/ModelCard";
import { loadersApi } from "../api/loaders";
import type { ModelInfo } from "../types";

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
            const data = await apiClient.get<{ models?: ModelInfo[] }>("api/setup/models");
            setModels(data.models || []);
        } catch (e) {
            console.error("Failed to fetch models", e);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchModels();
    }, [fetchModels]);

    const handleActivate = async (id: string) => {
        const model = models.find(m => m.id === id);
        if (!model) return;

        try {
            if (model.role === "text") {
                // For text models, we might need to ask which role (character or professional)
                // For simplicity in this hub view, let's set it as the default Character model for now
                // OR providing a dialog/dropdown would be better.
                // Let's replicate "Set as Active Character Model" behavior
                await apiClient.post("api/setup/model/roles/character", {
                    model_id: id,
                });
            } else if (model.role === "embedding") {
                await apiClient.post("api/setup/model/active", {
                    model_id: id,
                    role: "embedding",
                });

                const modelPath =
                    model.file_path ||
                    ((model.source === "ollama" || model.loader === "ollama") && model.filename
                        ? `ollama://${model.filename}`
                        : (model.source === "lmstudio" || model.loader === "lmstudio") && model.filename
                            ? `lmstudio://${model.filename}`
                            : model.filename
                                ? `models/embedding/${model.filename}`
                                : "");

                if (modelPath && config?.models_gguf?.embedding_model) {
                    updateModel("embedding_model", {
                        ...config.models_gguf.embedding_model,
                        path: modelPath,
                    });
                }
            }
            // Refresh list to update 'is_active' status (if backend returns it)
            fetchModels();
        } catch (e) {
            console.error("Failed to activate model", e);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm(t("settings.sections.models.confirm_delete", "Are you sure you want to delete this model?"))) return;

        try {
            await apiClient.delete(`api/setup/model/${id}`);
            fetchModels();
        } catch (e) {
            console.error("Failed to delete model", e);
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
            console.error("Failed to refresh loaders", e);
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
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="flex flex-col w-full max-w-5xl h-[85vh] bg-theme-panel text-theme-text rounded-2xl overflow-hidden relative shadow-2xl border border-white/10 animate-in zoom-in-95 duration-200">
                {/* Ambient Background Glow */}
                <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-gold-900/20 rounded-full blur-[120px] pointer-events-none" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-tea-900/10 rounded-full blur-[150px] pointer-events-none" />

                {/* Header */}
                <div className="flex-none px-6 py-5 border-b border-white/5 bg-white/[0.02] flex items-center justify-between z-10">
                    <div className="flex items-center gap-4">
                        <div>
                            <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2 text-cinzel">
                                <Grid size={20} className="text-gold-400" />
                                {t("modelHub.title", "Visual Model Hub")}
                            </h1>
                            <p className="text-xs text-tea-200/70 font-medium">
                                {t("modelHub.subtitle", "Manage your local AI models library")}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleRefreshLoaders}
                            disabled={isRefreshing}
                            className="glass-button px-4 py-2 flex items-center gap-2 text-sm font-semibold text-tea-100/90"
                        >
                            <Server size={16} className={isRefreshing ? "animate-spin text-gold-400" : "text-tea-300"} />
                            <span className="hidden sm:inline">
                                {isRefreshing ? t("common.refreshing", "Refreshing...") : t("common.scan_providers", "Scan Providers")}
                            </span>
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Controls Bar */}
                <div className="flex-none px-6 py-4 border-b border-border-subtle bg-black/10 flex flex-col sm:flex-row items-start sm:items-center gap-4 z-10 w-full">
                    {/* Search */}
                    <div className="relative w-full sm:max-w-md lg:max-w-lg">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tea-300/60" size={18} />
                        <input
                            type="text"
                            placeholder={t("modelHub.search_placeholder", "Search models...")}
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="glass-input w-full pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none placeholder-tea-200/40"
                        />
                    </div>

                    {/* Filter Tabs */}
                    <div className="flex glass-base p-1.5 w-full sm:w-auto overflow-x-auto no-scrollbar">
                        {(["all", "text", "embedding"] as const).map((role) => (
                            <button
                                key={role}
                                onClick={() => setFilterRole(role)}
                                className={`
                                px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all whitespace-nowrap
                                ${filterRole === role
                                        ? "bg-white/15 text-gold-300 shadow-[0_2px_10px_rgba(0,0,0,0.2)]"
                                        : "text-tea-200/60 hover:text-tea-100 hover:bg-white/5"}
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
                <div className="flex-1 overflow-y-auto p-6 md:p-8 custom-scrollbar z-10">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center h-full text-tea-300/60 gap-4">
                            <RefreshCw className="animate-spin text-gold-400" size={32} />
                            <span className="text-sm font-medium tracking-wide uppercase">{t("common.loading", "Loading models...")}</span>
                        </div>
                    ) : filteredModels.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-tea-300/60 gap-3">
                            <div className="w-16 h-16 rounded-2xl glass-base flex items-center justify-center mb-2">
                                <Grid size={32} className="text-tea-100/20" />
                            </div>
                            <p className="text-base font-medium">{t("modelHub.no_models_found", "No models found matching your criteria.")}</p>
                            <button className="text-gold-400 text-sm font-semibold mt-2 hover:text-gold-300 transition-colors" onClick={() => { setSearchTerm(""); setFilterRole("all"); }}>
                                {t("common.clear_filters", "Clear Filters")}
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5 md:gap-6 auto-rows-max">
                            {filteredModels.map(model => (
                                <ModelCard
                                    key={model.id}
                                    model={model}
                                    isActive={model.is_active || false}
                                    onActivate={handleActivate}
                                    onDelete={handleDelete}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
};

export default ModelHub;
