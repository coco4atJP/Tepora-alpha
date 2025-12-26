import React, { useState, useEffect } from 'react';
import { Users, Check, Plus, Trash2 } from 'lucide-react';
import { SettingsSection, FormGroup, FormInput, FormList, FormSelect } from '../SettingsComponents';
import { API_BASE } from '../../../utils/api';
import { useTranslation } from 'react-i18next';

// Types (Local for now, should be shared)
interface AgentProfile {
    label: string;
    description: string;
    persona: {
        key?: string;
        prompt?: string;
    };
    tool_policy: {
        allow: string[];
        deny: string[];
    };
}

interface PersonaPreset {
    key: string;
    preview: string;
}

interface CharacterSettingsProps {
    profiles: Record<string, AgentProfile>;
    activeProfileId: string;
    onUpdateProfile: (key: string, profile: AgentProfile) => void;
    onSetActive: (key: string) => void;
    onAddProfile: (key: string) => void;
    onDeleteProfile: (key: string) => void;
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
    const [personaPresets, setPersonaPresets] = useState<PersonaPreset[]>([]);
    const [newProfileKey, setNewProfileKey] = useState('');
    const [showAddDialog, setShowAddDialog] = useState(false);

    // Fetch persona presets on mount
    useEffect(() => {
        const fetchPresets = async () => {
            try {
                const response = await fetch(`${API_BASE}/api/personas`);
                if (response.ok) {
                    const data = await response.json();
                    setPersonaPresets(data.personas || []);
                }
            } catch (err) {
                console.error('Failed to fetch persona presets:', err);
            }
        };
        fetchPresets();
    }, []);

    const handleAddProfile = () => {
        if (!newProfileKey.trim()) return;
        // Generate a safe key from the input
        const key = newProfileKey.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (key && !profiles[key]) {
            onAddProfile(key);
            setNewProfileKey('');
            setShowAddDialog(false);
        }
    };

    const handleDeleteProfile = (key: string) => {
        if (key === activeProfileId) {
            alert(t('settings.sections.agents.cannot_delete_active'));
            return;
        }
        if (confirm(t('settings.sections.agents.confirm_delete'))) {
            onDeleteProfile(key);
        }
    };

    // Helper to render individual card
    const renderAgentCard = (key: string, profile: AgentProfile) => {
        const isActive = activeProfileId === key;

        const updateField = <K extends keyof AgentProfile>(field: K, value: AgentProfile[K]) => {
            onUpdateProfile(key, { ...profile, [field]: value });
        };

        const updatePersona = (field: 'key' | 'prompt', value: string) => {
            onUpdateProfile(key, { ...profile, persona: { ...profile.persona, [field]: value } });
        };

        return (
            <div key={key} className={`settings-agent-card ${isActive ? 'settings-agent-card--active' : ''}`}>
                <div className="settings-agent-card__header">
                    <div className="flex items-center gap-2 flex-1">
                        <Users size={18} className="text-gold-400" />
                        <h3 className="settings-agent-card__title">{profile.label || key}</h3>
                        <span className="text-xs text-gray-500 font-mono">({key})</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => onSetActive(key)}
                            className={`settings-agent-card__active-btn ${isActive ? 'settings-agent-card__active-btn--active' : ''}`}
                            title={isActive ? t('settings.sections.agents.card.currently_active') : t('settings.sections.agents.card.set_active')}
                        >
                            {isActive && <Check size={14} />}
                            {isActive ? t('settings.sections.agents.card.active') : t('settings.sections.agents.card.set_active_short')}
                        </button>
                        {!isActive && (
                            <button
                                type="button"
                                onClick={() => handleDeleteProfile(key)}
                                className="settings-list__item-remove"
                                title={t('settings.sections.agents.card.delete')}
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <FormGroup label={t('settings.sections.agents.card.label')}>
                        <FormInput
                            value={profile.label}
                            onChange={(v) => updateField('label', v as string)}
                            placeholder={t('settings.sections.agents.card.label_placeholder')}
                        />
                    </FormGroup>
                    <FormGroup label={t('settings.sections.agents.card.description')}>
                        <FormInput
                            value={profile.description}
                            onChange={(v) => updateField('description', v as string)}
                            placeholder={t('settings.sections.agents.card.description_placeholder')}
                        />
                    </FormGroup>
                </div>

                <FormGroup label={t('settings.sections.agents.card.persona')} description={t('settings.sections.agents.card.persona_description')}>
                    <div className="space-y-3">
                        <div className="grid grid-cols-[120px_1fr] gap-4 items-center">
                            <span className="text-sm text-gray-400">{t('settings.sections.agents.card.preset_key')}</span>
                            {personaPresets.length > 0 ? (
                                <FormSelect
                                    value={profile.persona.key || ''}
                                    onChange={(v) => updatePersona('key', v as string)}
                                    options={[
                                        { value: '', label: t('settings.sections.agents.card.select_preset') },
                                        ...personaPresets.map(p => ({ value: p.key, label: p.key }))
                                    ]}
                                />
                            ) : (
                                <FormInput
                                    value={profile.persona.key || ''}
                                    onChange={(v) => updatePersona('key', v as string)}
                                    placeholder={t('settings.sections.agents.card.preset_key_placeholder')}
                                    className="font-mono text-sm"
                                />
                            )}
                        </div>
                        <div>
                            <span className="text-sm text-gray-400 mb-1 block">{t('settings.sections.agents.card.custom_prompt')}</span>
                            <textarea
                                value={profile.persona.prompt || ''}
                                onChange={(e) => updatePersona('prompt', e.target.value)}
                                className="settings-input settings-input--textarea w-full font-sans leading-relaxed text-sm p-3 bg-black/20 rounded border border-white/10"
                                rows={4}
                                placeholder={t('settings.sections.agents.card.custom_prompt_placeholder')}
                            />
                        </div>
                    </div>
                </FormGroup>

                <div className="mt-4 pt-4 border-t border-white/5">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <FormGroup label={t('settings.sections.agents.card.allowed_tools')} description={t('settings.sections.agents.card.allowed_tools_description')}>
                            <FormList
                                items={profile.tool_policy.allow}
                                onChange={(items) => onUpdateProfile(key, { ...profile, tool_policy: { ...profile.tool_policy, allow: items } })}
                                placeholder={t('settings.sections.agents.card.tool_placeholder')}
                            />
                        </FormGroup>
                        <FormGroup label={t('settings.sections.agents.card.denied_tools')}>
                            <FormList
                                items={profile.tool_policy.deny}
                                onChange={(items) => onUpdateProfile(key, { ...profile, tool_policy: { ...profile.tool_policy, deny: items } })}
                                placeholder={t('settings.sections.agents.card.tool_placeholder')}
                            />
                        </FormGroup>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <SettingsSection
            title={t('settings.sections.agents.title')}
            icon={<Users size={18} />}
            description={t('settings.sections.agents.description')}
        >
            {/* Profile Cards */}
            {Object.entries(profiles).map(([key, profile]) => renderAgentCard(key, profile))}

            {/* Add Profile Section */}
            {showAddDialog ? (
                <div className="settings-agent-card" style={{ borderStyle: 'dashed' }}>
                    <div className="flex items-center gap-4">
                        <FormInput
                            value={newProfileKey}
                            onChange={(v) => setNewProfileKey(v as string)}
                            placeholder={t('settings.sections.agents.new_profile_key_placeholder')}
                            className="flex-1"
                        />
                        <button
                            type="button"
                            onClick={handleAddProfile}
                            className="settings-list__add-button"
                            disabled={!newProfileKey.trim()}
                        >
                            <Plus size={16} />
                            {t('settings.sections.agents.add')}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setShowAddDialog(false);
                                setNewProfileKey('');
                            }}
                            className="settings-save-btn--secondary"
                            style={{ padding: '0.5rem 1rem' }}
                        >
                            {t('settings.sections.agents.cancel')}
                        </button>
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => setShowAddDialog(true)}
                    className="settings-list__add-button"
                    style={{ width: '100%', justifyContent: 'center', padding: '1rem', marginTop: '1rem' }}
                >
                    <Plus size={18} />
                    {t('settings.sections.agents.add_new_profile')}
                </button>
            )}
        </SettingsSection>
    );
};

export default CharacterSettings;
