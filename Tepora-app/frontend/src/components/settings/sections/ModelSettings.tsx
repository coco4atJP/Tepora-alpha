import React from 'react';
import { Cpu, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsSection, FormGroup, FormInput, FormSelect } from '../SettingsComponents';
import ModelManagerSettings from '../ModelManagerSettings';

// Types
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

interface LlmManagerConfig {
    process_terminate_timeout: number;
    health_check_timeout: number;
    health_check_interval: number;
    tokenizer_model_key: string;
}

interface ModelSettingsProps {
    llmConfig: LlmManagerConfig;
    modelsConfig: {
        character_model: ModelConfig;
        executor_model: ModelConfig;
        embedding_model: ModelConfig;
    };
    onUpdateLlm: (field: keyof LlmManagerConfig, value: unknown) => void;
    onUpdateModel: (key: keyof ModelSettingsProps['modelsConfig'], config: ModelConfig) => void;
}

const ModelCard: React.FC<{
    name: string;
    config: ModelConfig;
    onChange: (c: ModelConfig) => void;
    isEmbedding?: boolean;
}> = ({ name, config, onChange, isEmbedding }) => {
    const { t } = useTranslation();
    const update = <K extends keyof ModelConfig>(f: K, v: ModelConfig[K]) => onChange({ ...config, [f]: v });

    return (
        <div className="settings-model-card">
            <div className="settings-model-card__header">
                <Cpu size={18} className="text-purple-400" />
                <h3 className="settings-model-card__title">{name}</h3>
            </div>
            <div className="settings-model-card__grid">
                <FormGroup label={t('settings.models_settings.configurations.path')}>
                    <FormInput value={config.path} onChange={(v) => update('path', v as string)} placeholder="models/*.gguf" className="font-mono text-xs" />
                </FormGroup>
                <FormGroup label={t('settings.models_settings.configurations.port')}>
                    <FormInput type="number" value={config.port} onChange={(v) => update('port', v as number)} />
                </FormGroup>
                <FormGroup label={t('settings.models_settings.configurations.context')}>
                    <FormInput type="number" value={config.n_ctx} onChange={(v) => update('n_ctx', v as number)} step={512} />
                </FormGroup>
                <FormGroup label={t('settings.models_settings.configurations.gpu_layers')}>
                    <FormInput type="number" value={config.n_gpu_layers} onChange={(v) => update('n_gpu_layers', v as number)} min={-1} />
                </FormGroup>

                {!isEmbedding && (
                    <>
                        <FormGroup label={t('settings.models_settings.configurations.temp')}>
                            <FormInput type="number" value={config.temperature ?? 0.7} onChange={(v) => update('temperature', v as number)} step={0.1} />
                        </FormGroup>
                        <FormGroup label={t('settings.models_settings.configurations.top_p')}>
                            <FormInput type="number" value={config.top_p ?? 0.9} onChange={(v) => update('top_p', v as number)} step={0.05} />
                        </FormGroup>
                    </>
                )}
            </div>
        </div>
    );
};

const ModelSettings: React.FC<ModelSettingsProps> = ({ llmConfig, modelsConfig, onUpdateLlm, onUpdateModel }) => {
    const { t } = useTranslation();

    return (
        <div className="space-y-6">
            {/* 1. Global Manager Settings */}
            <SettingsSection
                title={t('settings.models_settings.global_manager.title')}
                icon={<Cpu size={18} />}
                description={t('settings.models_settings.global_manager.description')}
            >
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <FormGroup label={t('settings.models_settings.global_manager.terminate_timeout')}>
                        <FormInput
                            type="number"
                            value={llmConfig.process_terminate_timeout}
                            onChange={(v) => onUpdateLlm('process_terminate_timeout', v)}
                            min={1}
                        />
                    </FormGroup>
                    <FormGroup label={t('settings.models_settings.global_manager.health_check_timeout')}>
                        <FormInput
                            type="number"
                            value={llmConfig.health_check_timeout}
                            onChange={(v) => onUpdateLlm('health_check_timeout', v)}
                            min={1}
                        />
                    </FormGroup>
                    <FormGroup label={t('settings.models_settings.global_manager.health_check_interval')}>
                        <FormInput
                            type="number"
                            value={llmConfig.health_check_interval}
                            onChange={(v) => onUpdateLlm('health_check_interval', v)}
                            step={0.1}
                        />
                    </FormGroup>
                    <FormGroup label={t('settings.models_settings.global_manager.tokenizer_model')}>
                        <FormSelect
                            value={llmConfig.tokenizer_model_key}
                            onChange={(v) => onUpdateLlm('tokenizer_model_key', v)}
                            options={[
                                { value: 'character_model', label: 'Character' },
                                { value: 'executor_model', label: 'Executor' },
                                { value: 'embedding_model', label: 'Embedding' },
                            ]}
                        />
                    </FormGroup>
                </div>
            </SettingsSection>

            {/* 2. Download Manager */}
            <SettingsSection
                title={t('settings.models_settings.download_manager.title')}
                icon={<HardDrive size={18} />}
                description={t('settings.models_settings.download_manager.description')}
            >
                {/* Reusing existing component but it might need style tweaks, contained here */}
                <div className="bg-black/20 rounded-xl p-4 border border-white/5">
                    <ModelManagerSettings />
                </div>
            </SettingsSection>

            {/* 3. Individual Model Configs */}
            <SettingsSection
                title={t('settings.models_settings.configurations.title')}
                icon={<Cpu size={18} />}
                description={t('settings.models_settings.configurations.description')}
            >
                <div className="space-y-4">
                    <ModelCard
                        name="Character Model"
                        config={modelsConfig.character_model}
                        onChange={(c) => onUpdateModel('character_model', c)}
                    />
                    <ModelCard
                        name="Executor Model"
                        config={modelsConfig.executor_model}
                        onChange={(c) => onUpdateModel('executor_model', c)}
                    />
                    <ModelCard
                        name="Embedding Model"
                        config={modelsConfig.embedding_model}
                        onChange={(c) => onUpdateModel('embedding_model', c)}
                        isEmbedding
                    />
                </div>
            </SettingsSection>
        </div>
    );
};

export default ModelSettings;
