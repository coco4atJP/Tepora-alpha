import React, { useState } from 'react';
import { Users, Check, Plus, Trash2, Edit2, Bot, Briefcase } from 'lucide-react';
import { SettingsSection, FormGroup, FormInput } from '../SettingsComponents';
import { CharacterConfig } from '../../../types';
import { useTranslation } from 'react-i18next';
import Modal from '../../ui/Modal';

interface CharacterSettingsProps {
    profiles: Record<string, CharacterConfig>;
    activeProfileId: string;
    onUpdateProfile: (key: string, profile: CharacterConfig) => void;
    onSetActive: (key: string) => void;
    onAddProfile: (key: string) => void;
    onDeleteProfile: (key: string) => void;
}

interface EditState {
    key: string;
    config: CharacterConfig;
    isNew: boolean;
}

const CharacterSettings: React.FC<CharacterSettingsProps> = ({
    profiles,
    activeProfileId,
    onUpdateProfile,
    onSetActive,
    onAddProfile,
    onDeleteProfile,
}) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<'characters' | 'professionals'>('characters');

    // Edit Modal State
    const [editState, setEditState] = useState<EditState | null>(null);
    const [newKeyInput, setNewKeyInput] = useState('');

    const handleEdit = (key: string, config: CharacterConfig) => {
        setEditState({ key, config: { ...config }, isNew: false });
    };

    const handleStartAdd = () => {
        setEditState({
            key: '',
            config: {
                name: 'New Character',
                description: '',
                system_prompt: 'You are a helpful assistant.',
            },
            isNew: true
        });
        setNewKeyInput('');
    };

    const handleSaveEdit = () => {
        if (!editState) return;

        if (editState.isNew) {
            // Validate key
            const key = newKeyInput.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
            if (!key) {
                alert(t('settings.sections.agents.error_empty_key'));
                return;
            }
            if (profiles[key]) {
                alert(t('settings.sections.agents.error_duplicate_key'));
                return;
            }

            // Add then Update
            onAddProfile(key);
            setTimeout(() => {
                onUpdateProfile(key, editState.config);
            }, 100);

        } else {
            onUpdateProfile(editState.key, editState.config);
        }
        setEditState(null);
    };

    const handleDelete = (key: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (key === activeProfileId) {
            alert(t('settings.sections.agents.cannot_delete_active'));
            return;
        }
        if (confirm(t('settings.sections.agents.confirm_delete'))) {
            onDeleteProfile(key);
        }
    };

    // --- Render Helpers ---

    const renderCharacterCard = (key: string, config: CharacterConfig) => {
        const isActive = activeProfileId === key;
        return (
            <div
                key={key}
                className={`
                    relative group flex flex-col p-4 rounded-xl border transition-all duration-200 cursor-pointer
                    ${isActive
                        ? 'bg-gold-500/10 border-gold-500/50 shadow-[0_0_15px_rgba(255,215,0,0.1)]'
                        : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'
                    }
                `}
                onClick={() => onSetActive(key)}
            >
                {/* Active Indicator */}
                <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                        <Users size={18} className={isActive ? "text-gold-400" : "text-gray-400"} />
                        <h3 className={`font-medium ${isActive ? 'text-gold-100' : 'text-gray-200'}`}>
                            {config.name || key}
                        </h3>
                    </div>
                    {isActive && <Check size={16} className="text-gold-400" />}
                </div>

                <p className="text-xs text-gray-500 font-mono mb-3 truncate">@{key}</p>

                <p className="text-sm text-gray-400 line-clamp-2 mb-4 h-10">
                    {config.description || t('settings.sections.agents.no_description')}
                </p>

                {/* Actions (visible on hover or active) */}
                <div className="mt-auto flex gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                        onClick={(e) => { e.stopPropagation(); handleEdit(key, config); }}
                        className="p-1.5 hover:bg-white/10 rounded-md text-gray-400 hover:text-white transition-colors"
                        title={t('settings.sections.agents.edit')}
                    >
                        <Edit2 size={14} />
                    </button>
                    {!isActive && (
                        <button
                            onClick={(e) => handleDelete(key, e)}
                            className="p-1.5 hover:bg-red-500/20 rounded-md text-gray-400 hover:text-red-400 transition-colors"
                            title={t('settings.sections.agents.delete')}
                        >
                            <Trash2 size={14} />
                        </button>
                    )}
                </div>
            </div>
        );
    };

    const renderAddCard = () => (
        <button
            onClick={handleStartAdd}
            className="flex flex-col items-center justify-center p-4 rounded-xl border border-white/10 border-dashed bg-white/5 hover:bg-white/10 hover:border-white/30 transition-all gap-3 h-full min-h-[160px] group"
        >
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-white/10 transition-colors">
                <Plus size={20} className="text-gray-400 group-hover:text-white" />
            </div>
            <span className="text-sm text-gray-400 group-hover:text-white font-medium">
                {t('settings.sections.agents.add_new_profile')}
            </span>
        </button>
    );

    return (
        <SettingsSection
            title={t('settings.sections.agents.title')}
            icon={<Users size={18} />}
            description={t('settings.sections.agents.description')}
        >
            {/* Tabs */}
            <div className="flex gap-4 mb-6 border-b border-white/10">
                <button
                    onClick={() => setActiveTab('characters')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative ${activeTab === 'characters' ? 'text-gold-400' : 'text-gray-400 hover:text-white'
                        }`}
                >
                    <span className="flex items-center gap-2">
                        <Users size={16} />
                        {t('settings.sections.agents.tab.characters')}
                    </span>
                    {activeTab === 'characters' && (
                        <div className="absolute bottom-0 left-0 w-full h-0.5 bg-gold-400" />
                    )}
                </button>
                <button
                    onClick={() => setActiveTab('professionals')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative ${activeTab === 'professionals' ? 'text-gold-400' : 'text-gray-400 hover:text-white'
                        }`}
                >
                    <span className="flex items-center gap-2">
                        <Briefcase size={16} />
                        {t('settings.sections.agents.tab.professionals')}
                    </span>
                    {activeTab === 'professionals' && (
                        <div className="absolute bottom-0 left-0 w-full h-0.5 bg-gold-400" />
                    )}
                </button>
            </div>

            {/* Content Area */}
            {activeTab === 'characters' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {/* Ensure profiles is an object before mapping */}
                    {profiles && Object.entries(profiles).map(([key, config]) => renderCharacterCard(key, config))}
                    {renderAddCard()}
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center border border-white/5 rounded-xl bg-white/5">
                    <Bot size={48} className="text-white/20 mb-4" />
                    <h3 className="text-lg font-medium text-white/50 mb-2">
                        {t('settings.sections.agents.professionals_coming_soon_title')}
                    </h3>
                    <p className="text-sm text-white/30 max-w-sm">
                        {t('settings.sections.agents.professionals_coming_soon_desc')}
                    </p>
                </div>
            )}

            {/* Edit Modal */}
            <Modal
                isOpen={!!editState}
                onClose={() => setEditState(null)}
                title={editState?.isNew ? t('settings.sections.agents.modal.title_add') : t('settings.sections.agents.modal.title_edit')}
            >
                {editState && (
                    <div className="space-y-4 p-1">
                        {editState.isNew && (
                            <FormGroup label={t('settings.sections.agents.modal.key_label')} description={t('settings.sections.agents.modal.key_desc')}>
                                <FormInput
                                    value={newKeyInput}
                                    onChange={(v) => setNewKeyInput(v as string)}
                                    placeholder="e.g. coding_assistant"
                                    className="font-mono"
                                />
                            </FormGroup>
                        )}

                        <FormGroup label={t('settings.sections.agents.modal.name_label')}>
                            <FormInput
                                value={editState.config.name}
                                onChange={(v) => setEditState({ ...editState, config: { ...editState.config, name: v as string } })}
                                placeholder="Display Name"
                            />
                        </FormGroup>

                        <FormGroup label={t('settings.sections.agents.modal.desc_label')}>
                            <FormInput
                                value={editState.config.description}
                                onChange={(v) => setEditState({ ...editState, config: { ...editState.config, description: v as string } })}
                                placeholder="Short description..."
                            />
                        </FormGroup>

                        <FormGroup label={t('settings.sections.agents.modal.prompt_label')} description="The core personality definition.">
                            <textarea
                                value={editState.config.system_prompt}
                                onChange={(e) => setEditState({ ...editState, config: { ...editState.config, system_prompt: e.target.value } })}
                                className="w-full h-40 bg-black/20 border border-white/10 rounded-md p-3 text-sm text-gray-200 focus:outline-none focus:border-gold-500/50 resize-y font-mono"
                                placeholder="System Prompt..."
                            />
                        </FormGroup>

                        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/10">
                            <button
                                onClick={() => setEditState(null)}
                                className="px-4 py-2 rounded-md hover:bg-white/10 text-sm text-gray-300 transition-colors"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={handleSaveEdit}
                                className="px-4 py-2 rounded-md bg-gold-500 hover:bg-gold-600 text-black text-sm font-medium transition-colors"
                            >
                                {t('common.save')}
                            </button>
                        </div>
                    </div>
                )}
            </Modal>
        </SettingsSection>
    );
};

export default CharacterSettings;
