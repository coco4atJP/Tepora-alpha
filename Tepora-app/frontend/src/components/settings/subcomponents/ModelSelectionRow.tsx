import React, { useState } from 'react';
import { Settings, Cpu, Trash2 } from 'lucide-react';
import { ModelDetailOverlay } from './ModelDetailOverlay';

interface ModelInfo {
    id: string;
    display_name: string;
    role: string;
}

interface ModelConfig {
    path: string;
    port: number;
    n_ctx: number;
    n_gpu_layers: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    logprobs?: boolean;
}

interface ModelSelectionRowProps {
    label: string;
    description?: string;
    icon?: React.ReactNode;
    role: string;
    selectedModelId: string | undefined;
    models: ModelInfo[];
    onSelect: (modelId: string) => void;

    config: ModelConfig;
    onUpdateConfig: (config: ModelConfig) => void;
    onDelete?: () => void;
}

export const ModelSelectionRow: React.FC<ModelSelectionRowProps> = ({
    label,
    description,
    icon,
    role,
    selectedModelId,
    models,
    onSelect,
    config,
    onUpdateConfig,
    onDelete
}) => {
    const [isDetailOpen, setIsDetailOpen] = useState(false);

    // Use models as passed from parent (parent handles filtering)
    const availableModels = models;

    return (
        <div className="bg-black/20 rounded-xl p-6 border border-white/5 space-y-4">
            <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-white/5 rounded-lg text-gold-400">
                    {icon || <Cpu size={20} />}
                </div>
                <div className="flex-1">
                    <h3 className="text-lg font-medium text-white">{label}</h3>
                    {description && <p className="text-sm text-gray-500">{description}</p>}
                </div>
                {onDelete && (
                    <button
                        onClick={onDelete}
                        className="p-2 text-gray-400 hover:text-red-400 transition-colors opacity-60 hover:opacity-100"
                        title="Remove Mapping"
                    >
                        <Trash2 size={18} />
                    </button>
                )}
            </div>

            <div className="flex gap-4">
                <div className="flex-1 relative">
                    <select
                        value={selectedModelId || ''}
                        onChange={(e) => onSelect(e.target.value)}
                        className="w-full appearance-none bg-white/5 border border-white/10 hover:border-white/20 rounded-xl px-4 py-3 pr-10 text-white font-medium transition-colors focus:outline-none focus:border-gold-400/50"
                    >
                        <option value="" disabled>Select a model...</option>
                        {availableModels.map(m => (
                            <option key={m.id} value={m.id} className="bg-gray-900">
                                {m.display_name}
                            </option>
                        ))}
                        {availableModels.length === 0 && <option value="" disabled>No models available</option>}
                    </select>
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                        <svg width="12" height="8" viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                </div>

                <button
                    onClick={() => setIsDetailOpen(true)}
                    className="p-3 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 hover:text-white text-gray-400 transition-colors"
                    title="Model Configurations"
                >
                    <Settings size={20} />
                </button>
            </div>

            <ModelDetailOverlay
                isOpen={isDetailOpen}
                onClose={() => setIsDetailOpen(false)}
                title={`${label} Configuration`}
                config={config}
                onChange={onUpdateConfig}
                isEmbedding={role === 'embedding'}
            />
        </div>
    );
};
