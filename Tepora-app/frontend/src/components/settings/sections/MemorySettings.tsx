import React from 'react';
import { Brain, Clock } from 'lucide-react';
import { SettingsSection, FormGroup, FormInput, FormSwitch } from '../SettingsComponents';
import { useTranslation } from 'react-i18next';

// Types
interface EmLlmConfig {
    surprise_gamma: number;
    min_event_size: number;
    max_event_size: number;
    total_retrieved_events: number;
    repr_topk: number;
    use_boundary_refinement: boolean;
}

interface ChatHistoryConfig {
    max_tokens: number;
}

interface MemorySettingsProps {
    emConfig: EmLlmConfig;
    historyConfig: ChatHistoryConfig;
    onUpdateEm: (field: keyof EmLlmConfig, value: unknown) => void;
    onUpdateHistory: (field: keyof ChatHistoryConfig, value: unknown) => void;
}

const MemorySettings: React.FC<MemorySettingsProps> = ({ emConfig, historyConfig, onUpdateEm, onUpdateHistory }) => {
    const { t } = useTranslation();

    return (
        <div className="space-y-6">
            <SettingsSection title={t('settings.sections.chat_history.title')} icon={<Clock size={18} />}>
                <FormGroup label={t('settings.memory.max_tokens.label')} description={t('settings.memory.max_tokens.description')}>
                    <FormInput
                        type="number"
                        value={historyConfig.max_tokens}
                        onChange={(v) => onUpdateHistory('max_tokens', v)}
                        min={1024}
                        step={1024}
                    />
                </FormGroup>
            </SettingsSection>

            <SettingsSection title={t('settings.sections.memory.title')} icon={<Brain size={18} />} description={t('settings.sections.memory.description')}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <FormGroup label={t('settings.memory.surprise_gamma.label')} description={t('settings.memory.surprise_gamma.description')}>
                        <FormInput
                            type="number"
                            value={emConfig.surprise_gamma}
                            onChange={(v) => onUpdateEm('surprise_gamma', v)}
                            min={0}
                            max={1}
                            step={0.05}
                        />
                    </FormGroup>

                    <FormGroup label={t('settings.memory.min_event_size.label')} description={t('settings.memory.min_event_size.description')}>
                        <FormInput
                            type="number"
                            value={emConfig.min_event_size}
                            onChange={(v) => onUpdateEm('min_event_size', v)}
                            min={1}
                        />
                    </FormGroup>
                    <FormGroup label={t('settings.memory.max_event_size.label')} description={t('settings.memory.max_event_size.description')}>
                        <FormInput
                            type="number"
                            value={emConfig.max_event_size}
                            onChange={(v) => onUpdateEm('max_event_size', v)}
                            min={1}
                        />
                    </FormGroup>

                    <FormGroup label={t('settings.memory.retrieved_events.label')} description={t('settings.memory.retrieved_events.description')}>
                        <FormInput
                            type="number"
                            value={emConfig.total_retrieved_events}
                            onChange={(v) => onUpdateEm('total_retrieved_events', v)}
                            min={1}
                            max={50}
                        />
                    </FormGroup>
                    <FormGroup label={t('settings.memory.repr_topk.label')} description={t('settings.memory.repr_topk.description')}>
                        <FormInput
                            type="number"
                            value={emConfig.repr_topk}
                            onChange={(v) => onUpdateEm('repr_topk', v)}
                            min={1}
                            max={50}
                        />
                    </FormGroup>

                    <div className="flex items-center h-full pt-4">
                        <FormGroup label={t('settings.memory.boundary_refinement.label')} description={t('settings.memory.boundary_refinement.description')}>
                            <div className="flex items-center gap-3">
                                <FormSwitch
                                    checked={emConfig.use_boundary_refinement}
                                    onChange={(v) => onUpdateEm('use_boundary_refinement', v)}
                                />
                                <span className="text-sm text-gray-400">
                                    {emConfig.use_boundary_refinement ? t('common.enabled') : t('common.disabled')}
                                </span>
                            </div>
                        </FormGroup>
                    </div>
                </div>
            </SettingsSection>
        </div>
    );
};

export default MemorySettings;
