import React, { useState } from 'react';
import { X, Trash2, ArrowUp, ArrowDown, List } from 'lucide-react';

interface ModelInfo {
    id: string;
    display_name: string;
    role: string;
    file_size: number;
    filename?: string;
    source: string;
}

interface ModelListOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    models: ModelInfo[];
    onDelete: (id: string) => void;
    onReorder: (role: string, newOrder: string[]) => void;
}

export const ModelListOverlay: React.FC<ModelListOverlayProps> = ({
    isOpen,
    onClose,
    models,
    onDelete,
    onReorder
}) => {
    const [activeTab, setActiveTab] = useState('character');

    if (!isOpen) return null;

    const filteredModels = models.filter(m => m.role === activeTab);

    const move = (index: number, direction: 'up' | 'down') => {
        const newModels = [...filteredModels];
        const swapIndex = direction === 'up' ? index - 1 : index + 1;

        if (swapIndex < 0 || swapIndex >= newModels.length) return;

        [newModels[index], newModels[swapIndex]] = [newModels[swapIndex], newModels[index]];

        onReorder(activeTab, newModels.map(m => m.id));
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
                <div className="flex items-center justify-between p-6 border-b border-white/5">
                    <h3 className="text-lg font-medium text-white flex items-center gap-2">
                        <List size={20} className="text-gold-400" />
                        Model Management
                    </h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <div className="flex border-b border-white/5 px-6">
                    {['character', 'executor', 'embedding'].map(role => (
                        <button
                            key={role}
                            onClick={() => setActiveTab(role)}
                            className={`py-3 mr-6 text-sm font-medium border-b-2 transition-colors ${activeTab === role
                                ? 'text-gold-400 border-gold-400'
                                : 'text-gray-500 border-transparent hover:text-gray-300'
                                }`}
                        >
                            {role.charAt(0).toUpperCase() + role.slice(1)} ({models.filter(m => m.role === role).length})
                        </button>
                    ))}
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-2">
                    {filteredModels.length === 0 ? (
                        <div className="text-center text-gray-500 py-10">No models found for this role.</div>
                    ) : (
                        filteredModels.map((model, index) => (
                            <div key={model.id} className="bg-black/20 p-4 rounded-lg flex items-center justify-between group hover:bg-white/5 transition-colors border border-transparent hover:border-white/5">
                                <div>
                                    <div className="font-medium text-white">{model.display_name}</div>
                                    <div className="text-xs text-gray-500">{model.filename || model.source} • {(model.file_size / 1024 / 1024).toFixed(1)} MB</div>
                                </div>
                                <div className="flex items-center gap-2 opacity-100 sm:opacity-50 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={() => move(index, 'up')}
                                        disabled={index === 0}
                                        className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 text-gray-400 hover:text-white"
                                    >
                                        <ArrowUp size={16} />
                                    </button>
                                    <button
                                        onClick={() => move(index, 'down')}
                                        disabled={index === filteredModels.length - 1}
                                        className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 text-gray-400 hover:text-white"
                                    >
                                        <ArrowDown size={16} />
                                    </button>
                                    <div className="w-px h-6 bg-white/10 mx-2" />
                                    <button
                                        onClick={() => onDelete(model.id)}
                                        className="p-2 hover:bg-red-500/20 text-red-400 hover:text-red-300 rounded-full transition-colors"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
