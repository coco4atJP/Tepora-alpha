import React from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsSection, FormGroup, FormInput, FormList, FormSelect } from '../SettingsComponents';

// To make this cleaner, I will define types here matching the Config structure we saw earlier.
interface AppConfig {
    max_input_length: number;
    graph_recursion_limit: number;
    tool_execution_timeout: number;
    dangerous_patterns: string[];
    language: string;
}

interface GeneralSettingsProps {
    config: AppConfig;
    onChange: (field: keyof AppConfig, value: unknown) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({ config, onChange }) => {
    const { t, i18n } = useTranslation();

    const handleLanguageChange = (lang: string) => {
        onChange('language', lang);
        i18n.changeLanguage(lang);
    };

    return (
        <SettingsSection
            title={t('settings.sections.general.title')}
            icon={<SettingsIcon size={18} />}
            description={t('settings.sections.general.description')}
        >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormGroup
                    label={t('settings.fields.language.label')}
                    description={t('settings.fields.language.description')}
                >
                    <FormSelect
                        value={config.language || 'en'}
                        onChange={handleLanguageChange}
                        options={[
                            { value: 'en', label: 'English' },
                            { value: 'ja', label: '日本語' },
                        ]}
                    />
                </FormGroup>

                <FormGroup
                    label={t('settings.fields.max_input_length.label')}
                    description={t('settings.fields.max_input_length.description')}
                >
                    <FormInput
                        type="number"
                        value={config.max_input_length}
                        onChange={(v) => onChange('max_input_length', v)}
                        min={100}
                        max={100000}
                    />
                </FormGroup>

                <FormGroup
                    label={t('settings.fields.graph_recursion_limit.label')}
                    description={t('settings.fields.graph_recursion_limit.description')}
                >
                    <FormInput
                        type="number"
                        value={config.graph_recursion_limit}
                        onChange={(v) => onChange('graph_recursion_limit', v)}
                        min={1}
                        max={200}
                    />
                </FormGroup>

                <FormGroup
                    label={t('settings.fields.tool_execution_timeout.label')}
                    description={t('settings.fields.tool_execution_timeout.description')}
                >
                    <FormInput
                        type="number"
                        value={config.tool_execution_timeout}
                        onChange={(v) => onChange('tool_execution_timeout', v)}
                        min={10}
                        max={600}
                    />
                </FormGroup>
            </div>

            <div className="mt-6">
                <FormGroup
                    label={t('settings.fields.dangerous_patterns.label')}
                    description={t('settings.fields.dangerous_patterns.description')}
                >
                    <FormList
                        items={config.dangerous_patterns}
                        onChange={(items) => onChange('dangerous_patterns', items)}
                        placeholder={t('settings.fields.dangerous_patterns.placeholder')}
                    />
                </FormGroup>
            </div>
        </SettingsSection>
    );
};

export default GeneralSettings;
