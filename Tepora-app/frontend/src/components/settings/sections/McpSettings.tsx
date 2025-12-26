import React from 'react';
import { Database, FolderOpen, AlertCircle } from 'lucide-react';
import { SettingsSection } from '../SettingsComponents';
import { useTranslation } from 'react-i18next';

/**
 * MCP Settings Section.
 * Currently displays configuration information only, as MCP configuration
 * is file-based and read-only from the UI perspective.
 */
const McpSettings: React.FC = () => {
    const { t } = useTranslation();

    return (
        <SettingsSection
            title={t('settings.sections.mcp.title')}
            icon={<Database size={18} />}
            description={t('settings.sections.mcp.description')}
        >
            {/* Information Panel */}
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6 mb-6">
                <div className="flex items-start gap-4">
                    <AlertCircle className="text-blue-400 shrink-0 mt-1" size={24} />
                    <div>
                        <h3 className="text-lg font-medium text-blue-100 mb-2">{t('settings.mcp_content.info.title')}</h3>
                        <p className="text-blue-200/80 leading-relaxed text-sm">
                            {t('settings.mcp_content.info.description')}
                        </p>
                    </div>
                </div>
            </div>

            {/* Configuration Path */}
            <div className="bg-black/20 border border-white/5 rounded-xl p-6">
                <h3 className="text-md font-medium text-gray-200 mb-4 flex items-center gap-2">
                    <FolderOpen size={18} className="text-gray-400" />
                    {t('settings.mcp_content.config_path.title')}
                </h3>
                <code className="block w-full bg-black/40 border border-white/10 rounded-lg p-3 text-sm text-gray-400 font-mono break-all group relative">
                    backend/src/mcp_tools_config.json
                    <span className="absolute right-3 top-3 text-xs text-gray-600">({t('settings.mcp_content.config_path.readonly')})</span>
                </code>
                <p className="mt-2 text-xs text-gray-500">
                    {t('settings.mcp_content.config_path.helper')}
                </p>
            </div>
        </SettingsSection>
    );
};

export default McpSettings;
