import React, { useState, useEffect } from 'react';
import { User, Check, Plus, Trash2, Edit2, X, Save, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { API_BASE, getAuthHeaders } from '../utils/api';

interface Persona {
    id: string;
    name: string;
    description: string;
    role_instruction: string;
}

interface PersonaSwitcherProps {
    currentPersonaId: string;
    onPersonaChange: (personaId: string) => void;
}

const PersonaSwitcher: React.FC<PersonaSwitcherProps> = ({ currentPersonaId, onPersonaChange }) => {
    const { t } = useTranslation();
    const [personas, setPersonas] = useState<Persona[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    // Initial load
    useEffect(() => {
        fetchPersonas();
    }, []);

    const fetchPersonas = async () => {
        try {
            const response = await fetch(`${API_BASE}/api/personas`, {
                headers: { ...getAuthHeaders() }
            });
            if (response.ok) {
                const data = await response.json();
                setPersonas(data);
            }
        } catch (error) {
            console.error('Failed to fetch personas:', error);
        }
    };

    const handleCreate = () => {
        setEditingPersona({
            id: '', // Backend assigns ID
            name: '',
            description: '',
            role_instruction: ''
        });
        setIsEditing(true);
        setIsOpen(false);
    };

    const handleEdit = (persona: Persona, e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingPersona(persona);
        setIsEditing(true);
        setIsOpen(false);
    };

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!confirm(t('personas.confirm_delete'))) return;

        try {
            await fetch(`${API_BASE}/api/personas/${id}`, {
                method: 'DELETE',
                headers: { ...getAuthHeaders() }
            });
            await fetchPersonas();
            if (currentPersonaId === id && personas.length > 0) {
                // Switch to default if current is deleted
                const remaining = personas.filter(p => p.id !== id);
                if (remaining.length > 0) onPersonaChange(remaining[0].id);
            }
        } catch (error) {
            console.error('Failed to delete persona:', error);
        }
    };

    const handleSave = async () => {
        if (!editingPersona || !editingPersona.name) return;

        setIsLoading(true);
        try {
            const method = editingPersona.id ? 'PUT' : 'POST';
            const url = editingPersona.id
                ? `${API_BASE}/api/personas/${editingPersona.id}`
                : `${API_BASE}/api/personas`;

            await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...getAuthHeaders()
                },
                body: JSON.stringify(editingPersona)
            });

            await fetchPersonas();
            setIsEditing(false);
            setEditingPersona(null);
        } catch (error) {
            console.error('Failed to save persona:', error);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            {/* Main Switcher Button */}
            <div className="relative">
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="glass-button p-2 flex items-center gap-2 hover:bg-white/10 transition-all group"
                    title={t('personas.switch')}
                >
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-tea-400 to-tea-700 flex items-center justify-center border border-white/10 shadow-lg">
                        <User className="w-4 h-4 text-white" />
                    </div>
                </button>

                {/* Dropdown Menu */}
                {isOpen && (
                    <>
                        <div
                            className="fixed inset-0 z-40"
                            onClick={() => setIsOpen(false)}
                        />
                        <div className="absolute bottom-full left-0 mb-2 w-64 glass-panel rounded-xl overflow-hidden animate-fade-in z-50">
                            <div className="p-3 border-b border-white/5 flex justify-between items-center bg-black/40">
                                <h3 className="text-xs font-bold text-tea-200 uppercase tracking-wider">{t('personas.select')}</h3>
                                <button
                                    onClick={handleCreate}
                                    className="p-1 hover:bg-white/10 rounded-full text-green-400 transition-colors"
                                    title={t('personas.create')}
                                >
                                    <Plus size={14} />
                                </button>
                            </div>

                            <div className="max-h-60 overflow-y-auto custom-scrollbar p-1">
                                {personas.map(persona => (
                                    <div
                                        key={persona.id}
                                        onClick={() => {
                                            onPersonaChange(persona.id);
                                            setIsOpen(false);
                                        }}
                                        className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all ${currentPersonaId === persona.id
                                            ? 'bg-white/10'
                                            : 'hover:bg-white/5'
                                            }`}
                                    >
                                        <div className="flex items-center gap-3 overflow-hidden">
                                            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${currentPersonaId === persona.id
                                                ? 'bg-gold-500 text-black'
                                                : 'bg-tea-800 text-tea-200'
                                                } shrink-0`}>
                                                <User size={14} />
                                            </div>
                                            <div className="min-w-0">
                                                <div className={`text-sm font-medium truncate ${currentPersonaId === persona.id ? 'text-gold-300' : 'text-gray-200'
                                                    }`}>
                                                    {persona.name}
                                                </div>
                                            </div>
                                        </div>

                                        {currentPersonaId === persona.id && (
                                            <Check className="w-4 h-4 text-gold-400 ml-2 shrink-0" />
                                        )}

                                        <div className="hidden group-hover:flex items-center gap-1 ml-2">
                                            <button
                                                onClick={(e) => handleEdit(persona, e)}
                                                className="p-1 hover:text-blue-400 text-gray-500 transition-colors"
                                            >
                                                <Edit2 size={12} />
                                            </button>
                                            {persona.id !== 'default' && (
                                                <button
                                                    onClick={(e) => handleDelete(persona.id, e)}
                                                    className="p-1 hover:text-red-400 text-gray-500 transition-colors"
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* Edit/Create Modal */}
            {isEditing && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
                    <div className="glass-panel w-full max-w-lg p-6 space-y-4 animate-modal-enter">
                        <div className="flex justify-between items-center mb-2">
                            <h2 className="text-xl font-display text-gradient-tea">
                                {editingPersona?.id ? t('personas.edit') : t('personas.create_new')}
                            </h2>
                            <button onClick={() => setIsEditing(false)} className="text-gray-400 hover:text-white">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">
                                    {t('personas.name')}
                                </label>
                                <input
                                    type="text"
                                    value={editingPersona?.name || ''}
                                    onChange={e => setEditingPersona(prev => prev ? { ...prev, name: e.target.value } : null)}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-tea-100 focus:border-tea-500 focus:outline-none"
                                    placeholder="e.g. Coding Assistant"
                                />
                            </div>

                            <div>
                                <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">
                                    {t('personas.description')}
                                </label>
                                <input
                                    type="text"
                                    value={editingPersona?.description || ''}
                                    onChange={e => setEditingPersona(prev => prev ? { ...prev, description: e.target.value } : null)}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-gray-300 focus:border-tea-500 focus:outline-none"
                                    placeholder="Brief description..."
                                />
                            </div>

                            <div>
                                <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">
                                    {t('personas.instruction')}
                                </label>
                                <textarea
                                    value={editingPersona?.role_instruction || ''}
                                    onChange={e => setEditingPersona(prev => prev ? { ...prev, role_instruction: e.target.value } : null)}
                                    className="w-full h-40 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-gray-300 focus:border-tea-500 focus:outline-none resize-none font-mono text-sm"
                                    placeholder="You are a helpful AI assistant..."
                                />
                            </div>
                        </div>

                        <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
                            <button
                                onClick={() => setIsEditing(false)}
                                className="px-4 py-2 rounded-lg hover:bg-white/5 text-gray-400 text-sm transition-colors"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={isLoading || !editingPersona?.name}
                                className="glass-button px-6 py-2 flex items-center gap-2 bg-tea-600/20 text-tea-300 hover:bg-tea-600/40 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isLoading ? <RefreshCw className="animate-spin w-4 h-4" /> : <Save className="w-4 h-4" />}
                                {t('common.save')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

export default PersonaSwitcher;
